"use strict";

const express = require("express");
const debug = require("debug");
const debugHealth = debug("photovault:health");
const config = require("../config");
const database = require("../services/database-service");

// Internal state to track if we've already achieved a "Full Green" state
let hasReportedHealthy = false;

async function warmTemporalChannel(temporalClient) {
  if (!temporalClient) return;
  try {
    const channel = temporalClient.workflowService.client.getChannel();
    channel.getConnectivityState(true);
  } catch (err) { /* silent warmup */ }
}

async function checkMinioHealth(minioClient) {
  if (!minioClient) return false;
  try {
    return await minioClient.bucketExists(config.minio.bucketName || "photovault");
  } catch (err) { return false; }
}

async function checkTemporalHealth(temporalClient) {
  if (!temporalClient) return false;
  try {
    await temporalClient.workflowService.describeNamespace({
      namespace: config.temporal?.namespace || "default",
    }, { timeout: 2000 });
    return true;
  } catch (err) { return false; }
}

async function checkConverterHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${config.converter.url}/health`, { method: 'GET', signal: controller.signal });
    return response.ok;
  } catch (err) { return false; } finally { clearTimeout(timer); }
}

const healthCheck = (minioClient, temporalClient) => async (req, res) => {
  const [minioRes, dbRes, tempRes, convRes] = await Promise.allSettled([
    checkMinioHealth(minioClient),
    database.isHealthy(),
    checkTemporalHealth(temporalClient),
    checkConverterHealth(),
  ]);

  const isHealthy = (r) => r.status === "fulfilled" && r.value === true;
  const mUp = isHealthy(minioRes);
  const dUp = isHealthy(dbRes);
  const tUp = isHealthy(tempRes);
  const cUp = isHealthy(convRes);

  const allSystemGo = mUp && dUp && tUp && cUp;

  // LOGGING LOGIC:
  if (!hasReportedHealthy) {
    if (allSystemGo) {
      console.log("✅ ALL SERVICES REACHABLE: Health checks are now silencing.");
      hasReportedHealthy = true;
    } else {
      // Still warming up or failing - report the status to logs
      if (!mUp) debugHealth("⏳ Waiting for MinIO...");
      if (!dUp) debugHealth("⏳ Waiting for Database...");
      if (!tUp) debugHealth("⏳ Waiting for Temporal...");
      if (!cUp) debugHealth("⏳ Waiting for Converter...");
    }
  }

  // Liveness is always true to prevent restart loops
  // Readiness is true if core (DB/MinIO) are up
  res.status(200).json({
    ready: (dUp && mUp),
    services: { minio: mUp, database: dUp, temporal: tUp, converter: cUp }
  });
};

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();
  router.get("/health", healthCheck(minioClient, temporalClient));
  return router;
};

module.exports.warmTemporalChannel = warmTemporalChannel;