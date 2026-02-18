"use strict";

const express = require("express");
const debug = require("debug");
const debugHealth = debug("photovault:health");
const config = require("../config");
const database = require("../services/database-service");

// The only addition: A flag to track the transition from "Booting" to "Stable"
let hasReportedHealthy = false;

/**
 * Keepalive — call once at startup
 */
async function warmTemporalChannel(temporalClient) {
  if (!temporalClient) return;
  try {
    const channel = temporalClient.workflowService.client.getChannel();
    channel.getConnectivityState(true);

    await new Promise((resolve) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        const state = channel.getConnectivityState(false);
        if (state === 2 || state === 4 || state === 5 || Date.now() > deadline) {
          debugHealth(`Temporal channel state after warm-up: ${state}`);
          resolve();
        } else {
          setTimeout(poll, 100);
        }
      };
      poll();
    });
  } catch (err) {
    debugHealth("Temporal channel warm-up failed (non-fatal):", err.message);
  }
}

const MINIO_TIMEOUT_MS     = 2000;
const TEMPORAL_TIMEOUT_MS  = 2000;
const CONVERTER_TIMEOUT_MS = 2000;

async function checkMinioHealth(minioClient) {
  if (!minioClient) return false;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => done(false), MINIO_TIMEOUT_MS);
    try {
      const stream = minioClient.listObjectsV2(config.minio.bucketName || "photovault", "", true);
      stream.on("data",  () => { clearTimeout(timer); done(true);  });
      stream.on("end",   () => { clearTimeout(timer); done(true);  });
      stream.on("error", () => { clearTimeout(timer); done(false); });
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

async function checkTemporalHealth(temporalClient) {
  if (!temporalClient) return false;
  try {
    const channel = temporalClient.workflowService.client.getChannel();
    const state = channel.getConnectivityState(true);
    if (state === 4 || state === 5) return false;
  } catch (err) {
    debugHealth("Temporal channel state check failed:", err.message);
  }

  try {
    const raceResult = await Promise.race([
      temporalClient.workflowService
        .describeNamespace({ namespace: config.temporal?.namespace || "default" })
        .then(() => true),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), TEMPORAL_TIMEOUT_MS)
      ),
    ]);
    return raceResult;
  } catch {
    return false;
  }
}

async function checkConverterHealth() {
  const converterUrl = config.converter?.url;
  if (!converterUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONVERTER_TIMEOUT_MS);
  try {
    const response = await fetch(`${converterUrl}/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const healthCheck = (minioClient, temporalClient) => async (req, res) => {
  const [minioResult, databaseResult, temporalResult, converterResult] =
    await Promise.allSettled([
      checkMinioHealth(minioClient),
      database.isHealthy(),
      checkTemporalHealth(temporalClient),
      checkConverterHealth(),
    ]);

  const valueOf = (settled) =>
    settled.status === "fulfilled" ? Boolean(settled.value) : false;

  const mUp = valueOf(minioResult);
  const dUp = valueOf(databaseResult);
  const tUp = valueOf(temporalResult);
  const cUp = valueOf(converterResult);

  const isReady = mUp && cUp && dUp && tUp;
  const isAlive = dUp;

  // SILENCE LOGIC: 
  // We only log if we haven't achieved a "Full Green" state yet.
  if (!hasReportedHealthy) {
    if (isReady) {
      console.log("✅ ALL SERVICES REACHABLE: Health checks are now silencing.");
      hasReportedHealthy = true;
    } else {
      // Use standard console.log so you see it in K8s logs during boot
      if (!mUp) console.log("⏳ Waiting for MinIO...");
      if (!dUp) console.log("⏳ Waiting for Database...");
      if (!tUp) console.log("⏳ Waiting for Temporal...");
      if (!cUp) console.log("⏳ Waiting for Converter...");
    }
  }

  res.status(isAlive ? 200 : 503).json({
    status: isReady ? "healthy" : "degraded",
    ready: isReady,
    services: {
      minio: mUp,
      database: dUp,
      temporal: tUp,
      converter: cUp
    }
  });
};

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();
  router.get("/health", healthCheck(minioClient, temporalClient));
  return router;
};

module.exports.warmTemporalChannel = warmTemporalChannel;