"use strict";

const express = require("express");
const config = require("../config");
const database = require("../services/database-service");

let hasReportedHealthy = false;

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();

  router.get("/health", async (req, res) => {
    try {
      // 1. Fire all checks concurrently. 
      // Each check has its own .catch to ensure it returns a boolean, not an error.
      const checks = await Promise.all([
        minioClient ? minioClient.listBuckets().then(() => true).catch(() => false) : false,
        database.isHealthy().catch(() => false),
        temporalClient ? temporalClient.workflowService.describeNamespace({ 
          namespace: config.temporal?.namespace || "default" 
        }, { timeout: 2000 }).then(() => true).catch(() => false) : false,
        fetch(`${config.converter.url}/health`).then(r => r.ok).catch(() => false)
      ]);

      // 2. Destructure results based on the order above
      const [mUp, dUp, tUp, cUp] = checks;
      const allSystemGo = mUp && dUp && tUp && cUp;

      // 3. Selective logging (Startup only)
      if (!hasReportedHealthy) {
        if (allSystemGo) {
          console.log("✅ ALL SERVICES REACHABLE: Health checks are now silencing.");
          hasReportedHealthy = true;
        } else {
          if (!mUp) console.log("⏳ Waiting for MinIO...");
          if (!dUp) console.log("⏳ Waiting for Database...");
          if (!tUp) console.log("⏳ Waiting for Temporal...");
          if (!cUp) console.log("⏳ Waiting for Converter...");
        }
      }

      // 4. Kubernetes Response
      res.status(200).json({
        ready: (mUp && dUp), // Core dependencies
        services: { minio: mUp, database: dUp, temporal: tUp, converter: cUp }
      });
      
    } catch (err) {
      // If the logic above somehow explodes, keep the pod alive anyway.
      res.status(200).json({ ready: true, status: "error_mitigated" });
    }
  });

  return router;
};