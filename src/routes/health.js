"use strict";

const express = require("express");
const database = require("../services/database-service");

// Silence control
let hasReportedHealthy = false;
let loggedMinioError = false;
let loggedDbError = false;

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();

  router.get("/health", async (req, res) => {
    try {
      // Execute MinIO and MySQL checks in parallel
      const [mUp, dUp] = await Promise.all([
        // MinIO Check
        (async () => {
          if (!minioClient) return false;
          try {
            // listBuckets is the lightest 'real' check for MinIO
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
            // Using your existing service method
            const healthy = await database.isHealthy();
            if (!healthy && !hasReportedHealthy && !loggedDbError) {
              console.log("⏳ MySQL check failed: Service not initialized or ping failed");
              loggedDbError = true;
            }
            return healthy;
          } catch (err) {
            if (!hasReportedHealthy && !loggedDbError) {
              console.log(`⏳ MySQL check failed: ${err.message}`);
              loggedDbError = true;
            }
            return false;
          }
        })()
      ]);

      const allOk = mUp && dUp;

      // Handle the transition to 'Healthy' silence
      if (!hasReportedHealthy && allOk) {
        console.log("✅ MINIO & MYSQL REACHABLE: Silencing health logs.");
        hasReportedHealthy = true;
      }

      // If we lose health after being healthy, reset logs so we know why
      if (hasReportedHealthy && !allOk) {
        hasReportedHealthy = false;
        loggedMinioError = !mUp;
        loggedDbError = !dUp;
      }

      res.status(200).json({
        ready: allOk,
        minio: mUp,
        database: dUp
      });

    } catch (err) {
      // Fail-safe to prevent route from crashing the server
      res.status(200).json({ ready: false, error: "Internal check failure" });
    }
  });

  return router;
};

module.exports.warmTemporalChannel = () => {};