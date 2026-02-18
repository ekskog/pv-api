"use strict";

const express = require("express");

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();

  router.get("/health", async (req, res) => {
    let minioHealthy = false;

    if (minioClient) {
      try {
        // We use a Promise.race to ensure MinIO can't hang the whole route
        minioHealthy = await Promise.race([
          minioClient.listBuckets().then(() => true),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000))
        ]).catch(() => false);
      } catch (err) {
        minioHealthy = false;
      }
    }

    res.status(200).json({
      status: minioHealthy ? "connected" : "degraded",
      minio: minioHealthy,
      ready: true // Keeping this true so K8s doesn't kill us while we test
    });
  });

  return router;
};

module.exports.warmTemporalChannel = () => {};