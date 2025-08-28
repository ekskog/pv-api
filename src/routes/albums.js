// routes/albums.js
const express = require('express');
const router = express.Router();

const database = require('../services/database-service'); // Add database import
const config = require('../config'); // defaults to ./config/index.js

const debug = require('debug');
const debugAlbum = debug('photovault:album');
const debugMinio = debug('photovault:minio');

// GET /albums - List all albums (public access for album browsing)
const getAlbums = (minioClient) => async (req, res) => {
  debugAlbum(`[albums.js - line 10] Fetching albums from database`);
  try {
    const albums = await database.getAllAlbums();
    console.log('[DEBUG] Database returned:', albums.length, 'albums');
    
    res.json({
      success: true,
      data: albums,
      message: "Albums retrieved successfully",
      count: albums.length,
    });
  } catch (error) {
    console.log('[DEBUG] Database error:', error.message);
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

// Export factory function that accepts dependencies
module.exports = (minioClient) => {
    router.get('/albums', getAlbums(minioClient));
    router.get('/stats', getStats(minioClient));

    return router;
};