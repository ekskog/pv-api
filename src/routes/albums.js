// routes/albums.js
const express = require('express');
const debug = require('debug');

const debugAlbum = debug('photovault:album');
const debugMinio = debug('photovault:minio');

const router = express.Router();

// GET /albums - List all albums (public access for album browsing)
const getAlbums = (minioClient) => async (req, res) => {
  try {
    const folderSet = new Set();
debugAlbum(`[albums.js - line 14] Fetching albums from MinIO bucket: ${process.env.MINIO_BUCKET_NAME}`);
    const objectsStream = minioClient.listObjectsV2(
      process.env.MINIO_BUCKET_NAME,
      "",
      true
    );

    objectsStream.on("data", (obj) => {
      const key = obj.name;
      const topLevelPrefix = key.split("/")[0];
      if (key.includes("/")) {
        folderSet.add(topLevelPrefix);
      }
    });

    objectsStream.on("end", () => {
      debugMinio(`Number of top-level folders: ${folderSet.size}`);
      debugMinio(`${JSON.stringify([...folderSet], null, 2)}`);
    });

    objectsStream.on("error", (err) => {
      debugMinio(`Error listing objects: ${err}`);
    });

    res.json({
      success: true,
      data: [...folderSet],
      message: "Albums retrieved successfully",
      count: folderSet.size,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// GET /stats - Returns statistics for the bucket
const getStats = (minioClient) => async (req, res) => {
  try {
    const bucketName = process.env.MINIO_BUCKET_NAME;
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