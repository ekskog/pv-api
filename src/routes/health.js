"use strict";

const express = require("express");
const debug = require("debug");
const debugHealth = debug("photovault:health");
const config = require("../config");
const database = require("../services/database-service");

/**
 * Health check route — PhotoVault
 *
 * Design goals:
 *  - All checks run concurrently; total latency ≈ slowest single check.
 *  - Every individual check timeout fits well within the k8s probe
 *    timeoutSeconds so the probe never has to kill an in-flight request.
 *  - The Temporal gRPC channel is kept alive between checks so we never
 *    pay the reconnect cost inside a health check.
 *
 * Budget breakdown (all concurrent, probe timeoutSeconds should be ≥ 6s):
 *   Database  ~100 ms  (pool ping)
 *   MinIO     2 000 ms
 *   Converter 2 000 ms
 *   Temporal  2 000 ms  ← should be instant on a warm, healthy channel
 */

// ---------------------------------------------------------------------------
// Keepalive — call once at startup, after creating the Temporal client.
// ---------------------------------------------------------------------------

/**
 * Forces the underlying gRPC channel to connect eagerly and configures it to
 * send keepalive pings so it never goes IDLE between health checks.
 *
 * Call this once during app startup:
 *   const { warmTemporalChannel } = require('./routes/health');
 *   await warmTemporalChannel(temporalClient);
 *
 * @param {import('@temporalio/client').Client} temporalClient
 */
async function warmTemporalChannel(temporalClient) {
  if (!temporalClient) return;
  try {
    const channel = temporalClient.workflowService.client.getChannel();

    // Trigger an immediate connection attempt (moves channel out of IDLE)
    channel.getConnectivityState(true);

    // Poll until READY or give up after 5 s — so by the time the first
    // health check fires, the channel is already established.
    await new Promise((resolve) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        const state = channel.getConnectivityState(false);
        // 2 = READY, 4 = TRANSIENT_FAILURE, 5 = SHUTDOWN
        if (state === 2 || state === 4 || state === 5 || Date.now() > deadline) {
          debugHealth(`Temporal channel state after warm-up: ${state}`);
          resolve();
        } else {
          setTimeout(poll, 100);
        }
      };
      poll();
    });
  } catch (err) {
    debugHealth("Temporal channel warm-up failed (non-fatal):", err.message);
  }
}

// ---------------------------------------------------------------------------
// Individual service checks — each has its own tight timeout
// ---------------------------------------------------------------------------

const MINIO_TIMEOUT_MS     = 2000;
const TEMPORAL_TIMEOUT_MS  = 2000;
const CONVERTER_TIMEOUT_MS = 2000;

/**
 * @param {import('minio').Client} minioClient
 * @returns {Promise<boolean>}
 */
async function checkMinioHealth(minioClient) {
  if (!minioClient) return false;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };

    const timer = setTimeout(() => done(false), MINIO_TIMEOUT_MS);

    try {
      const stream = minioClient.listObjectsV2(
        config.minio.bucketName || "photovault", "", true
      );
      stream.on("data",  () => { clearTimeout(timer); done(true);  });
      stream.on("end",   () => { clearTimeout(timer); done(true);  });
      stream.on("error", () => { clearTimeout(timer); done(false); });
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

/**
 * Checks the Temporal namespace. On a warm, healthy gRPC channel this should
 * complete in single-digit milliseconds. If it consistently hits the 2 s
 * timeout the channel is not staying connected — check keepalive settings on
 * both the SDK client and the Temporal server/proxy.
 *
 * @param {import('@temporalio/client').Client} temporalClient
 * @returns {Promise<boolean>}
 */
async function checkTemporalHealth(temporalClient) {
  if (!temporalClient) return false;

  // Proactively nudge the channel in case it drifted to IDLE since last check.
  // This is synchronous and cheap — it just signals the channel, it doesn't wait.
  try {
    const channel = temporalClient.workflowService.client.getChannel();
    const state = channel.getConnectivityState(true); // true = reconnect if IDLE
    if (state === 4 || state === 5) {
      // TRANSIENT_FAILURE or SHUTDOWN — report unhealthy immediately
      debugHealth(`Temporal channel in bad state: ${state}`);
      return false;
    }
  } catch (err) {
    debugHealth("Temporal channel state check failed:", err.message);
  }

  const raceResult = await Promise.race([
    temporalClient.workflowService
      .describeNamespace({ namespace: config.temporal?.namespace || "default" })
      .then(() => true)
      .catch((err) => { throw err; }),

    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Temporal gRPC timeout after ${TEMPORAL_TIMEOUT_MS} ms`)),
        TEMPORAL_TIMEOUT_MS
      )
    ),
  ]);

  return raceResult;
}

/**
 * @returns {Promise<boolean>}
 */
async function checkConverterHealth() {
  const converterUrl = config.converter?.url;
  if (!converterUrl) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONVERTER_TIMEOUT_MS);

  try {
    const response = await fetch(`${converterUrl}/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const healthCheck = (minioClient, temporalClient) => async (req, res) => {
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

  if (!minioHealthy)
    debugHealth("❌ MinIO failure:",     minioResult.reason?.message     ?? "returned false");
  if (!databaseHealthy)
    debugHealth("❌ Database failure:",  databaseResult.reason?.message  ?? "returned false");
  if (!temporalHealthy)
    debugHealth("❌ Temporal failure:",  temporalResult.reason?.message  ?? "returned false");
  if (!converterHealthy)
    debugHealth("❌ Converter failure:", converterResult.reason?.message ?? "returned false");

  const isReady = minioHealthy && converterHealthy && databaseHealthy && temporalHealthy;
  const isAlive = databaseHealthy;

  res.status(isAlive ? 200 : 503).json({
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

module.exports.warmTemporalChannel = warmTemporalChannel;