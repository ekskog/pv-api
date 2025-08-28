// routes/albums.js
const express = require('express');
const router = express.Router();

const database = require('../services/database-service'); // Add database import
const config = require('../config'); // defaults to ./config/index.js

const debug = require('debug');
const debugAlbum = debug('photovault:album');
const debugMinio = debug('photovault:minio');

// GET /albums - List all albums (public access for album browsing)
const getAlbums = (minioClient, database) => async (req, res) => {
  try {
    console.log('[DEBUG] Fetching albums from database');
    const albums = await database.getAllAlbums();
    console.log('[DEBUG] Database returned:', albums.length, 'albums');

    // Map over albums and fetch object counts in MinIO
    const albumMetadata = await Promise.all(
      albums.map(async (album) => {
        const fileCount = await countObjectsInPath(minioClient, 'photovault', album.path);

        return {
          ...album,   // keep name, slug, path, description, etc.
          fileCount,
        };
      })
    );

    res.json({
      success: true,
      albums: albumMetadata,
    });
  } catch (error) {
    console.error('[DEBUG] Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};



// GET /stats - Returns statistics for the bucket
const getStats = (minioClient) => async (req, res) => {
    try {
        const bucketName = config.minio.bucketName;
        let fileCount = 0;
        let totalSize = 0;
        const folderSet = new Set();
        const fileTypeCounts = {};
        const folderTypeCounts = {};

        const objectsStream = minioClient.listObjectsV2(bucketName, '', true);

        objectsStream.on('data', (obj) => {
            if (obj.name && !obj.name.endsWith('/')) {
                fileCount++;
                totalSize += obj.size || 0;
                const pathParts = obj.name.split('/');
                const folder = pathParts.length > 1 ? pathParts[0] : '';
                if (folder) folderSet.add(folder);

                // Get file extension
                const extMatch = obj.name.match(/\.([a-zA-Z0-9]+)$/);
                const ext = extMatch ? extMatch[1].toLowerCase() : 'unknown';

                // Count file types globally
                fileTypeCounts[ext] = (fileTypeCounts[ext] || 0) + 1;

                // Count file types per folder
                if (folder) {
                    if (!folderTypeCounts[folder]) folderTypeCounts[folder] = {};
                    folderTypeCounts[folder][ext] = (folderTypeCounts[folder][ext] || 0) + 1;
                }
            }
        });

        objectsStream.on('end', () => {
            res.json({
                success: true,
                bucket: bucketName,
                fileCount,
                totalSize,
                uniqueFolders: Array.from(folderSet),
                fileTypeCounts,
                folderTypeCounts,
            });
        });

        objectsStream.on('error', (err) => {
            res.status(500).json({ success: false, error: err.message });
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// Helper: counts objects under a given prefix (album path) in MinIO
function countObjectsInPath(minioClient, bucket, prefix) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const stream = minioClient.listObjectsV2(bucket, prefix, true);

    stream.on('data', () => {
      count++;
    });

    stream.on('end', () => {
      resolve(count);
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

// Export factory function that accepts dependencies
module.exports = (minioClient) => {
    router.get('/albums', getAlbums(minioClient));
    router.get('/stats', getStats(minioClient));

    return router;
};