// routes/health.js
const express = require('express');
const debug = require('debug');

const debugHealth = debug('photovault:health');

// Health check route
const healthCheck = (minioClient, countAlbums) => async (req, res) => {
  debugHealth(`Health check from ${req.ip} at ${new Date().toISOString()}`);

  let minioHealthy = false;
  let converterHealthy = false;
  let albumsCount = 0;

  // MinIO check
  try {
    const albums = await countAlbums(process.env.MINIO_BUCKET_NAME);
    albumsCount = albums.length;
    minioHealthy = true;
    debugHealth(`MinIO healthy, ${albumsCount} albums`);
  } catch (error) {
    debugHealth(`MinIO failure: ${error.message}`);
  }

  // Converter check
  try {
    const converterUrl = process.env.AVIF_CONVERTER_URL;
    const timeout = parseInt(process.env.AVIF_CONVERTER_TIMEOUT, 10);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${converterUrl}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.ok) {
      converterHealthy = true;
      debugHealth(`Converter is healthy`);
    } else {
      debugHealth(`Converter unhealthy: ${response.status}`);
    }
  } catch (error) {
    debugHealth(`Converter failure: ${error.message}`);
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
      endpoint: process.env.MINIO_ENDPOINT,
    },
    converter: {
      connected: converterHealthy,
      endpoint: process.env.AVIF_CONVERTER_URL,
    },
  });
};

// Export factory function that accepts dependencies

module.exports = (minioClient, countAlbums) => {
  const router = express.Router(); // <-- moved inside the function
  router.get('/health', healthCheck(minioClient, countAlbums));
  return router;
};
