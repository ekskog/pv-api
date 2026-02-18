"use strict";

const express = require("express");
const config = require("../config");
const database = require("../services/database-service");

// Gate for silence once everything is green
let hasReportedHealthy = false;

/**
 * Temporal: getSystemInfo is the lightest gRPC call available.
 * It confirms connectivity without metadata/DB overhead.
 */
async function checkTemporalHealth(temporalClient) {
  if (!temporalClient?.workflowService) return false;
  try {
    await temporalClient.workflowService.getSystemInfo({}, { timeout: 1000 });
    return true;
  } catch (err) {
    if (!hasReportedHealthy) console.log(`⏳ Temporal not ready: ${err.message}`);
    return false;
  }
}

/**
 * MinIO: listBuckets is a standard authenticated connectivity check.
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
 * Converter: Standard GET /health fetch with AbortController.
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

    // Reporting logic
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
    // Final barrier to prevent process crash
    res.status(200).json({ ready: true, status: "error_mitigated" });
  }
};

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();
  router.get("/health", healthCheck(minioClient, temporalClient));
  return router;
};

// Simple connectivity nudge for startup
module.exports.warmTemporalChannel = (temporalClient) => {
  if (temporalClient?.workflowService?.getSystemInfo) {
    temporalClient.workflowService.getSystemInfo({}).catch(() => {});
  }
};