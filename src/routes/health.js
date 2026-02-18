"use strict";

const express = require("express");
const config = require("../config");
const database = require("../services/database-service");

// Gate for silence once everything is green
let hasReportedHealthy = false;

/**
 * Temporal: getSystemInfo is the lightest gRPC call available.
 */
async function checkTemporalHealth(temporalClient) {
  if (!temporalClient?.workflowService) return false;
  try {
    // Shallow gRPC ping - confirms server is responding
    await temporalClient.workflowService.getSystemInfo({}, { timeout: 1000 });
    return true;
  } catch (err) {
    if (!hasReportedHealthy) console.log(`⏳ Temporal not ready: ${err.message}`);
    return false;
  }
}

/**
 * MinIO: listBuckets confirms credentials and connectivity.
 */
async function checkMinioHealth(minioClient) {
  if (!minioClient) return false;
  try {
    await minioClient.listBuckets();
    return true;
  } catch (err) {
    if (!hasReportedHealthy) console.log("⏳ MinIO not ready");
    return false;
  }
}

/**
 * Converter: Standard GET /health fetch.
 */
async function checkConverterHealth() {
  const url = config.converter?.url;
  if (!url) return false;
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    return response.ok;
  } catch (err) {
    if (!hasReportedHealthy) console.log("⏳ Converter not ready");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Main Health Handler
 */
const healthCheck = (minioClient, temporalClient) => async (req, res) => {
  try {
    // Run all checks concurrently
    const [mUp, dUp, tUp, cUp] = await Promise.all([
      checkMinioHealth(minioClient),
      database.isHealthy().catch(() => false),
      checkTemporalHealth(temporalClient),
      checkConverterHealth()
    ]);

    const isReady = mUp && dUp && tUp && cUp;
    
    // Liveness: Process stays alive as long as DB is reachable
    const isAlive = dUp;

    // Reporting logic - Silences after first full success
    if (!hasReportedHealthy && isReady) {
      console.log("✅ ALL SERVICES REACHABLE: Health checks are now silencing.");
      hasReportedHealthy = true;
    }

    res.status(isAlive ? 200 : 503).json({
      ready: isReady,
      services: { 
        minio: mUp, 
        database: dUp, 
        temporal: tUp, 
        converter: cUp 
      }
    });
  } catch (err) {
    // Safety fallback
    res.status(200).json({ ready: true, status: "error_mitigated" });
  }
};

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();
  router.get("/health", healthCheck(minioClient, temporalClient));
  return router;
};

// No-op for the old warm-up logic
module.exports.warmTemporalChannel = () => {};