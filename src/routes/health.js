// routes/health.js
const express = require('express');
const debug = require('debug');
const debugHealth = debug('photovault:health');
const config = require('../config'); // defaults to ./config/index.js


// Health check route
const healthCheck = (minioClient) => async (req, res) => {
  debugHealth(`Health check from ${req.ip} at ${new Date().toISOString()}`);

  let minioHealthy = false;
  let converterHealthy = false;

  // MinIO check
  try {
    minioHealthy = await minioClient.listObjectsV2('photovault');
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
      endpoint: config.minio.endpoint,
    },
    converter: {
      connected: converterHealthy,
      endpoint: config.converter.url,
    },
  });
};

async function checkMinioHealth() {
  try {
    const stream = minioClient.listObjectsV2('photovault', '', true);

    return await new Promise((resolve, reject) => {
      let checked = false;

      stream.on('data', obj => {
        if (!checked) {
          checked = true;
          resolve(true); // Bucket is accessible and contains objects
        }
      });

      stream.on('end', () => {
        if (!checked) {
          resolve(true); // Bucket is accessible but empty
        }
      });

      stream.on('error', err => {
        console.error('MinIO health check failed:', err.message);
        resolve(false); // Treat error as unhealthy
      });
    });
  } catch (err) {
    console.error('MinIO health check exception:', err.message);
    return false;
  }
}

// Export factory function that accepts dependencies

module.exports = (minioClient, countAlbums) => {
  const router = express.Router(); // <-- moved inside the function
  router.get('/health', healthCheck(minioClient, countAlbums));
  return router;
};
