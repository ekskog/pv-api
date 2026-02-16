const express = require("express");
const debug = require("debug");
const debugHealth = debug("photovault:health");
const config = require("../config");
const database = require("../services/database-service");

/**
 * Health check route logic
 * Decoupled to allow the pod to stay alive (200 OK) even if non-critical 
 * services like Temporal or MinIO are still warming up or misconfigured.
 */
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

  // 2. Database check (This is our "Liveness" anchor)
  try {
    databaseHealthy = await database.isHealthy();
  } catch (err) {
    debugHealth("❌ Database unreachable:", err.message);
  }

  // 3. Temporal check
  try {
    if (temporalClient) {
      // Use a timeout to prevent the health check from hanging the gRPC call
      // if the TEMPORAL_ADDRESS is wrong or the namespace doesn't exist.
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Temporal gRPC Timeout")), 2000)
      );

      await Promise.race([
        temporalClient.workflowService.describeNamespace({
          namespace: "default",
        }),
        timeoutPromise,
      ]);
      temporalHealthy = true;
    }
  } catch (err) {
    debugHealth("❌ Temporal failure (Namespace 'default' likely missing or address wrong):", err.message);
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

  // --- LOGIC CHANGE START ---
  
  // We are "Ready" only if everything is perfect
  const isReady = minioHealthy && converterHealthy && databaseHealthy && temporalHealthy;
  
  // We are "Alive" if the Database is connected. 
  // If the DB is down, we actually want K8s to restart the pod.
  // If only Temporal is down, we want to stay alive to fix it!
  const isAlive = databaseHealthy;

  const status = isReady ? "healthy" : "degraded";
  const code = isAlive ? 200 : 503; 

  res.status(code).json({
    status,
    timestamp: new Date().toISOString(),
    ready: isReady,
    services: {
      minio: { connected: minioHealthy },
      database: { connected: databaseHealthy },
      temporal: { connected: temporalHealthy },
      converter: { connected: converterHealthy }
    },
    checks: {
      liveness: isAlive,
      readiness: isReady
    }
  });
  
  // --- LOGIC CHANGE END ---
};

async function checkMinioHealth(minioClient) {
  try {
    if (!minioClient) return false;
    // Simple check to see if we can talk to the bucket
    const stream = minioClient.listObjectsV2(config.minio.bucketName || "photovault", "", true);
    return await new Promise((resolve) => {
      let checked = false;
      stream.on("data", () => {
        if (!checked) { resolve(true); checked = true; }
      });
      stream.on("end", () => { if (!checked) resolve(true); });
      stream.on("error", () => resolve(false));
      // Safety timeout for the stream itself
      setTimeout(() => { if (!checked) resolve(false); }, 2000);
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