const express = require("express");
const debug = require("debug");
const debugHealth = debug("photovault:health");
const config = require("../config");
const database = require("../services/database-service");

// Health check route
const healthCheck = (minioClient, temporalClient) => async (req, res) => {
  let minioHealthy = false;
  let converterHealthy = false;
  let databaseHealthy = false;
  let temporalHealthy = false;

  // 1. MinIO check
  try {
    minioHealthy = await checkMinioHealth(minioClient);
  } catch (err) {
    debugHealth("❌ MinIO unreachable:", err.message);
  }

  // 2. Database check
  try {
    databaseHealthy = await database.isHealthy();
  } catch (err) {
    debugHealth("❌ Database unreachable:", err.message);
  }

  // 3. Temporal check
  try {
    if (temporalClient) {
      //describeNamespace confirms the connection is active and functional
      await temporalClient.workflowService.describeNamespace({
        namespace: "default",
      });
      temporalHealthy = true;
    }
  } catch (err) {
    debugHealth("❌ Temporal unreachable:", err.message);
  }

  // 4. Converter check
  try {
    const converterUrl = config.converter.url;
    const timeout = parseInt(config.converter.timeout, 10) || 5000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${converterUrl}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (response.ok) {
      converterHealthy = true;
    }
  } catch (error) {
    debugHealth(`❌ Converter failure: ${error.message}`);
  }

  // Compose response
  const isHealthy = minioHealthy && converterHealthy && databaseHealthy && temporalHealthy;
  const status = isHealthy ? "healthy" : "degraded";
  const code = isHealthy ? 200 : 503;

  res.status(code).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      minio: { connected: minioHealthy },
      database: { connected: databaseHealthy },
      temporal: { connected: temporalHealthy },
      converter: { connected: converterHealthy }
    }
  });
};

async function checkMinioHealth(minioClient) {
  try {
    if (!minioClient) return false;
    const stream = minioClient.listObjectsV2(config.minio.bucketName || "photovault", "", true);
    return await new Promise((resolve) => {
      let checked = false;
      stream.on("data", () => {
        if (!checked) { resolve(true); checked = true; }
      });
      stream.on("end", () => { if (!checked) resolve(true); });
      stream.on("error", () => resolve(false));
    });
  } catch (err) {
    return false;
  }
}

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();
  router.get("/health", healthCheck(minioClient, temporalClient));
  return router;
};