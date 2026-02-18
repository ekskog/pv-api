"use strict";

const express = require("express");
const debug = require("debug");
const debugHealth = debug("photovault:health");
const config = require("../config");
const database = require("../services/database-service");

/**
 * Lightweight health check
 * Prioritizes speed and process stability over deep dependency verification.
 */

async function warmTemporalChannel(temporalClient) {
  if (!temporalClient) return;
  try {
    const channel = temporalClient.workflowService.client.getChannel();
    channel.getConnectivityState(true);
    debugHealth("Temporal gRPC channel warm-up requested");
  } catch (err) {
    debugHealth("Temporal channel warm-up failed:", err.message);
  }
}

/**
 * Check MinIO - simplified to a top-level bucket existence check
 */
async function checkMinioHealth(minioClient) {
  if (!minioClient) return false;
  try {
    // bucketExists is much faster than listObjectsV2
    return await minioClient.bucketExists(config.minio.bucketName || "photovault");
  } catch (err) {
    return false;
  }
}

/**
 * Check Temporal - Using the built-in gRPC health service ping
 */
async function checkTemporalHealth(temporalClient) {
  if (!temporalClient) return false;
  try {
    // Standard gRPC health check (identity/ping)
    // Timeout is low (2s) to prevent blocking the event loop
    await temporalClient.workflowService.check({}, { timeout: 2000 });
    return true;
  } catch (err) {
    // If it's just a timeout, we log it but don't panic
    return false;
  }
}

/**
 * Check Converter - Using a HEAD request
 */
async function checkConverterHealth() {
  const converterUrl = config.converter.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`${converterUrl}/health`, {
      method: 'HEAD', 
      signal: controller.signal,
    });
    return response.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const healthCheck = (minioClient, temporalClient) => async (req, res) => {
  // 1. Run checks concurrently
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

  // Log failures for debugging
  if (!minioHealthy)     debugHealth("❌ MinIO failure");
  if (!databaseHealthy)  debugHealth("❌ Database failure");
  if (!temporalHealthy)  debugHealth("❌ Temporal failure");
  if (!converterHealthy) debugHealth("❌ Converter failure");

  // Readiness: Only true if the core storage (MinIO/DB) is up.
  // We treat Temporal/Converter as "soft" for the Load Balancer.
  const isReady = minioHealthy && databaseHealthy;

  // Liveness: If this code is executing, the Node.js process is "alive".
  // We return 200 regardless of dependencies to avoid restart loops.
  const isAlive = true; 

  res.status(200).json({
    status: isReady ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
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

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();
  router.get("/health", healthCheck(minioClient, temporalClient));
  return router;
};

module.exports.warmTemporalChannel = warmTemporalChannel;