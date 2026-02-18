"use strict";

const express = require("express");
const debug = require("debug");
const debugHealth = debug("photovault:health");
const config = require("../config");
const database = require("../services/database-service");

/**
 * Health check route logic
 * Decoupled to allow the pod to stay alive (200 OK) even if non-critical
 * services like Temporal or MinIO are still warming up or misconfigured.
 *
 * Improvements over previous version:
 *  1. All four checks run concurrently via Promise.allSettled — total latency
 *     is bounded by the slowest single check, not their sum.
 *  2. Temporal timeout raised to 4 s (well under the k8s readinessProbe
 *     timeoutSeconds: 5) to avoid false negatives on cold gRPC channels.
 *  3. The Temporal gRPC channel is warmed eagerly at startup via
 *     warmTemporalChannel() — call this once after creating your client so
 *     health-check calls never pay the connection-setup cost.
 *  4. Minor: converter fetch timeout now reads from config (falls back 4 s).
 */

// ---------------------------------------------------------------------------
// Channel warm-up — call once at application startup, BEFORE the first
// health check fires.  Safe to call multiple times; subsequent calls no-op.
// ---------------------------------------------------------------------------
/**
 * @param {import('@temporalio/client').Client} temporalClient
 */
async function warmTemporalChannel(temporalClient) {
  if (!temporalClient) return;
  try {
    // Asking the channel to transition out of IDLE triggers a TCP handshake
    // and TLS negotiation so subsequent calls find a ready connection.
    const channel = temporalClient.workflowService.client.getChannel();
    channel.getConnectivityState(true); // true = try to connect
    debugHealth("Temporal gRPC channel warm-up requested");
  } catch (err) {
    debugHealth("Temporal channel warm-up failed (non-fatal):", err.message);
  }
}

// ---------------------------------------------------------------------------
// Individual service checks
// ---------------------------------------------------------------------------

/**
 * Returns true if MinIO is reachable and the configured bucket is listable.
 * @param {import('minio').Client} minioClient
 * @returns {Promise<boolean>}
 */
async function checkMinioHealth(minioClient) {
  if (!minioClient) return false;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    // Safety timeout for the stream itself (keep below probe timeoutSeconds)
    const timer = setTimeout(() => done(false), 3000);

    try {
      const stream = minioClient.listObjectsV2(
        config.minio.bucketName || "photovault",
        "",
        true
      );
      stream.on("data", () => { clearTimeout(timer); done(true); });
      stream.on("end",  () => { clearTimeout(timer); done(true); });
      stream.on("error", () => { clearTimeout(timer); done(false); });
    } catch (err) {
      clearTimeout(timer);
      done(false);
    }
  });
}

/**
 * Returns true if the Temporal namespace is reachable.
 * Uses a 4 s timeout — long enough for a cold-but-healthy gRPC channel,
 * short enough to stay well within the k8s probe timeout.
 * @param {import('@temporalio/client').Client} temporalClient
 * @returns {Promise<boolean>}
 */
async function checkTemporalHealth(temporalClient) {
  if (!temporalClient) return false;

  const TEMPORAL_TIMEOUT_MS = 4000;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Temporal gRPC timeout after ${TEMPORAL_TIMEOUT_MS} ms`)),
      TEMPORAL_TIMEOUT_MS
    )
  );

  await Promise.race([
    temporalClient.workflowService.describeNamespace({
      namespace: config.temporal?.namespace || "default",
    }),
    timeoutPromise,
  ]);

  return true;
}

/**
 * Returns true if the converter sidecar responds with a 2xx on /health.
 * @returns {Promise<boolean>}
 */
async function checkConverterHealth() {
  const converterUrl = config.converter.url;
  // Keep converter timeout below the overall probe timeout too
  const timeout = Math.min(parseInt(config.converter.timeout, 10) || 4000, 4000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${converterUrl}/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const healthCheck = (minioClient, temporalClient) => async (req, res) => {
  // Run all checks concurrently so total latency ≈ slowest single check
  const [minioResult, databaseResult, temporalResult, converterResult] =
    await Promise.allSettled([
      checkMinioHealth(minioClient),
      database.isHealthy(),
      checkTemporalHealth(temporalClient),
      checkConverterHealth(),
    ]);

  const valueOf = (settled) =>
    settled.status === "fulfilled" ? Boolean(settled.value) : false;

  const minioHealthy     = valueOf(minioResult);
  const databaseHealthy  = valueOf(databaseResult);
  const temporalHealthy  = valueOf(temporalResult);
  const converterHealthy = valueOf(converterResult);

  // Log individual failures for easier debugging
  if (!minioHealthy)     debugHealth("❌ MinIO failure:",     minioResult.reason?.message     ?? "returned false");
  if (!databaseHealthy)  debugHealth("❌ Database failure:",  databaseResult.reason?.message  ?? "returned false");
  if (!temporalHealthy)  debugHealth("❌ Temporal failure:",  temporalResult.reason?.message  ?? "returned false");
  if (!converterHealthy) debugHealth("❌ Converter failure:", converterResult.reason?.message ?? "returned false");

  // "Ready" only when every dependency is healthy
  const isReady = minioHealthy && converterHealthy && databaseHealthy && temporalHealthy;

  // "Alive" as long as the database is up — Temporal/MinIO/converter issues
  // should NOT trigger a pod restart; they can be fixed without restarting.
  const isAlive = databaseHealthy;

  const httpStatus = isAlive ? 200 : 503;

  res.status(httpStatus).json({
    status: isReady ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    ready: isReady,
    services: {
      minio:     { connected: minioHealthy },
      database:  { connected: databaseHealthy },
      temporal:  { connected: temporalHealthy },
      converter: { connected: converterHealthy },
    },
    checks: {
      liveness:  isAlive,
      readiness: isReady,
    },
  });
};

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();
  router.get("/health", healthCheck(minioClient, temporalClient));
  return router;
};

// Export warm-up helper so app startup can call it
module.exports.warmTemporalChannel = warmTemporalChannel;
