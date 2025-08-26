// routes/health.js
const express = require('express');
const debug = require('debug');
const debugHealth = debug('photovault:health');
const config = require('../config'); // defaults to ./config/index.js


// Health check route
const healthCheck = (minioClient, countAlbums) => async (req, res) => {
  debugHealth(`Health check from ${req.ip} at ${new Date().toISOString()}`);

  let minioHealthy = false;
  let converterHealthy = false;
  let albumsCount = 0;

  // MinIO check
  try {
    const albums = await countAlbums(config.minio.bucketName);
    albumsCount = albums.length;
    minioHealthy = true;
    debugHealth(`[health.js - line 21]: MinIO healthy, ${albumsCount} albums`);
  } catch (error) {
    debugHealth(`[health.js - line 23]: MinIO failure: ${error.message}`);
  }

  // Converter check
  try {
    const converterUrl = config.converter.url;
    const timeout = parseInt(config.converter.timeout, 10);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${converterUrl}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.ok) {
      converterHealthy = true;
      debugHealth(`[health.js - line 42]: Converter is healthy`);
    } else {
      debugHealth(`[health.js - line 44]: Converter unhealthy: ${response.status}`);
    }
  } catch (error) {
    debugHealth(`[health.js - line 46]: Converter failure: ${error.message}`);
  }

  // Compose response
  const isHealthy = minioHealthy && converterHealthy;
  const status = isHealthy ? "healthy" : "degraded";
  const code = isHealthy ? 200 : 503;

  res.status(code).json({
    status,
    timestamp: new Date().toISOString(),
    minio: {
      connected: minioHealthy,
      albums: albumsCount,
      endpoint: config.minio.endpoint,
    },
    converter: {
      connected: converterHealthy,
      endpoint: config.converter.url,
    },
  });
};

// Export factory function that accepts dependencies

module.exports = (minioClient, countAlbums) => {
  const router = express.Router(); // <-- moved inside the function
  router.get('/health', healthCheck(minioClient, countAlbums));
  return router;
};
