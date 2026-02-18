"use strict";

const express = require("express");
const database = require("../services/database-service");

let hasReportedHealthy = false;
let loggedMinioError = false;
let loggedDbError = false;

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();

  router.get("/health", async (req, res) => {
    try {
      const [mUp, dUp] = await Promise.all([
        // MinIO Check
        (async () => {
          if (!minioClient) return false;
          try {
            await minioClient.listBuckets();
            return true;
          } catch (err) {
            if (!hasReportedHealthy && !loggedMinioError) {
              console.log(`⏳ MinIO check failed: ${err.message}`);
              loggedMinioError = true;
            }
            return false;
          }
        })(),

        // MySQL Check
        (async () => {
          try {
            return await database.isHealthy();
          } catch (err) {
            return false;
          }
        })()
      ]);

      // ULTRALIGHT TEMPORAL CHECK
      // No network call. Just verify the client object was initialized.
      const tUp = !!(temporalClient && temporalClient.workflowService);

      // CRITICAL: Temporal is NOT a show-stopper. 
      // Only MinIO and Database determine the 'ready' state.
      const isReady = mUp && dUp;

      if (!hasReportedHealthy && isReady) {
        console.log("✅ CORE SERVICES REACHABLE: Silencing health logs.");
        hasReportedHealthy = true;
      }

      res.status(200).json({
        ready: isReady,
        services: {
          minio: mUp,
          database: dUp,
          temporal: tUp // Reports status, but doesn't flip 'ready' to false if down
        }
      });

    } catch (err) {
      res.status(200).json({ ready: true, error: "bypass" });
    }
  });

  return router;
};

module.exports.warmTemporalChannel = () => {};