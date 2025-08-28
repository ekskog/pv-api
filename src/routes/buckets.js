// routes/albums.js
const express = require('express');
const debug = require('debug');
const database = require('../services/database-service'); // Add database import

const debugAlbum = debug('photovault:album');
const debugMinio = debug('photovault:minio');

const config = require('../config'); // defaults to ./config/index.js

const router = express.Router();

// GET /albums - List all albums from database (with slugs)
const getAlbums = (minioClient) => async (req, res) => {
  debugAlbum(`[albums.js - line 10] Fetching albums from database`);
  try {
    // Get albums from database first
    const albums = await database.getAllAlbums();
    
    debugAlbum(`[albums.js] Retrieved ${albums.length} albums from database`);
    
    res.json({
      success: true,
      data: albums,
      message: "Albums retrieved successfully",
      count: albums.length,
    });

  } catch (error) {
    debugAlbum(`[albums.js] Error fetching albums: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// GET /albums/minio - List albums from MinIO (legacy endpoint, kept for compatibility)
const getAlbumsFromMinio = (minioClient) => async (req, res) => {
  debugAlbum(`[albums.js] Fetching albums from MinIO bucket: ${config.minio.bucketName}`);
  try {
    const folderSet = new Set();

    // Wrap stream in a Promise
    const result = await new Promise((resolve, reject) => {
      const objectsStream = minioClient.listObjectsV2(
        config.minio.bucketName,
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
        debugMinio(`[albums.js]: Number of top-level folders: ${folderSet.size}`);
        debugMinio(`[albums.js]: ${JSON.stringify([...folderSet], null, 2)}`);

        resolve({
          success: true,
          data: [...folderSet],
          message: "Albums retrieved successfully from MinIO",
          count: folderSet.size,
        });
      });

      objectsStream.on("error", (err) => {
        debugMinio(`[albums.js]: Error listing objects: ${err}`);
        reject(err);
      });
    });

    debugAlbum(`[albums.js] Retrieved ${JSON.stringify(result, null, 2)}`);
    res.json(result);

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// GET /album/:slug - Get album by slug with its objects
const getAlbumBySlug = (minioClient) => async (req, res) => {
  try {
    const { slug } = req.params;
    debugAlbum(`[albums.js] Fetching album by slug: ${slug}`);
    
    const album = await database.getAlbumBySlug(slug);
    
    if (!album) {
      return res.status(404).json({
        success: false,
        error: 'Album not found'
      });
    }
    
    // Fetch the MinIO objects for this album using the album.path
    const objects = [];
    const stream = minioClient.listObjectsV2(config.minio.bucketName, album.path, true); // recursive = true to get all files
    
    for await (const obj of stream) {
      // Skip metadata JSON files
      if (obj.name.endsWith('.json') && obj.name.includes('/')) {
        const pathParts = obj.name.split('/');
        const fileName = pathParts[pathParts.length - 1];
        const folderName = pathParts[pathParts.length - 2];
        if (fileName === `${folderName}.json`) {
          continue;
        }
      }
      
      objects.push({
        name: obj.name,
        size: obj.size,
        lastModified: obj.lastModified,
        etag: obj.etag,
        type: "file",
      });
    }
    
    debugAlbum(`[albums.js] Found ${objects.length} objects in album ${slug}`);
    
    res.json({
      success: true,
      album: {
        ...album,
        objects: objects,
        objectCount: objects.length
      }
    });
  } catch (error) {
    debugAlbum(`[albums.js] Error fetching album by slug: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// GET /album/:slug/objects - Get only objects for an album (lighter endpoint)
const getAlbumObjects = (minioClient) => async (req, res) => {
  try {
    const { slug } = req.params;
    debugAlbum(`[albums.js] Fetching objects for album slug: ${slug}`);
    
    const album = await database.getAlbumBySlug(slug);
    
    if (!album) {
      return res.status(404).json({
        success: false,
        error: 'Album not found'
      });
    }
    
    // Fetch only the MinIO objects for this album
    const objects = [];
    const stream = minioClient.listObjectsV2(config.minio.bucketName, album.path, true);
    
    for await (const obj of stream) {
      // Skip metadata JSON files
      if (obj.name.endsWith('.json') && obj.name.includes('/')) {
        const pathParts = obj.name.split('/');
        const fileName = pathParts[pathParts.length - 1];
        const folderName = pathParts[pathParts.length - 2];
        if (fileName === `${folderName}.json`) {
          continue;
        }
      }
      
      objects.push({
        name: obj.name,
        size: obj.size,
        lastModified: obj.lastModified,
        etag: obj.etag,
        type: "file",
      });
    }
    
    res.json({
      success: true,
      albumInfo: {
        id: album.id,
        name: album.name,
        slug: album.slug,
        path: album.path
      },
      objects: objects,
      objectCount: objects.length
    });
  } catch (error) {
    debugAlbum(`[albums.js] Error fetching album objects: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
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
    // Main albums endpoint - now returns database albums with slugs
    router.get('/albums', getAlbums(minioClient));
    
    // Legacy MinIO-only endpoint for compatibility
    router.get('/albums/minio', getAlbumsFromMinio(minioClient));
    
    // New slug-based endpoints
    router.get('/album/:slug', getAlbumBySlug(minioClient));
    router.get('/album/:slug/objects', getAlbumObjects(minioClient));
    
    // Stats endpoint
    router.get('/stats', getStats(minioClient));

    return router;
};