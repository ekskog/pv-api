// routes/albums.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { authenticateToken } = require("../middleware/authMW");

const database = require("../services/database-service");
const config = require("../config");
const UploadService = require("../services/upload-service");

const debug = require("debug");
const debugAlbum = debug("photovault:album");
const debugMinio = debug("photovault:minio");
const debugUpload = debug("photovault:upload");

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB limit for large video files from iPhone
  },
});

const getAlbums = (minioClient) => async (req, res) => {
  try {
    const albums = await database.getAllAlbums();

    // Map over albums and fetch object counts in MinIO
    const albumMetadata = await Promise.all(
      albums.map(async (album) => {
        const fileCount =
          (await countObjectsInPath(minioClient, "photovault", album.path)) - 1;

        return {
          ...album, // keep name, slug, path, description, etc.
          fileCount,
        };
      })
    );

    res.json({
      success: true,
      albums: albumMetadata,
    });
  } catch (error) {
    console.error("[album.js line 35] Error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// GET /albums/:albumName/ - Get photos for album by name
const getPhotos = (minioClient) => async (req, res) => {
  try {
    const { name } = req.params;
    debugAlbum(`[albums.js line 49] Fetching album by name: ${name}`);

    const album = await database.getAlbumByName(name);

    if (!album) {
      return res.status(404).json({
        success: false,
        error: "Album not found",
      });
    }

    // Fetch the MinIO objects for this album using the album.path
    const objects = [];
    const stream = minioClient.listObjectsV2(
      config.minio.bucketName,
      album.path,
      true
    ); // recursive = true to get all files

    for await (const obj of stream) {
      // Skip metadata JSON files
      if (obj.name.endsWith(".json") && obj.name.includes("/")) {
        const pathParts = obj.name.split("/");
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

    debugAlbum(`[albums.js] Found ${objects.length} objects in album ${name}`);

    res.json({
      success: true,
      album: {
        ...album,
        objects: objects,
        objectCount: objects.length,
      },
    });
  } catch (error) {
    debugAlbum(`[albums.js] Error fetching album by slug: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// GET /albums/:name/object/:object - Fetch a single object from an album
const getObject = (minioClient) => async (req, res) => {
  try {
    const { name, object } = req.params;
    debugAlbum(`[albums.js - line 113] Fetching object "${object}" for album: ${name}`);

    const album = await database.getAlbumByName(name);
    if (!album) {
      return res.status(404).json({ success: false, error: "Album not found" });
    }

    const objectKey = `${album.path}${object}`;
    debugMinio(`[albums.js] Fetching MinIO object: ${objectKey}`);

    // Get object metadata first (for headers like content-type, length)
    const stat = await minioClient.statObject(config.minio.bucketName, objectKey);

    // Set response headers
    res.setHeader("Content-Type", stat.metaData["content-type"] || "application/octet-stream");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("ETag", stat.etag);

    // Stream object to response
    const stream = await minioClient.getObject(config.minio.bucketName, objectKey);
    stream.pipe(res);

    stream.on("error", (err) => {
      debugMinio(`[albums.js] Error streaming object: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    });
  } catch (error) {
    debugAlbum(`[albums.js] Error fetching object: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

// POST /buckets/:bucketName/upload - Upload files to a bucket
const uploadFiles = (minioClient, processFilesInBackground) => async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4(); // Generate unique job ID for this upload

  try {
    const { bucketName } = req.params;
    const { folderPath = "" } = req.body;
    const files = req.files;

    debugUpload(`[albums.js] Upload request received:`, {
      jobId,
      bucket: bucketName,
      folder: folderPath,
      filesCount: files ? files.length : 0,
      user: req.user?.username || "unknown",
      timestamp: new Date().toISOString(),
    });

    if (!files || files.length === 0) {
      debugUpload(`[albums.js] Upload failed: No files provided`);
      return res.status(400).json({
        success: false,
        error: "No files provided",
      });
    }

    const response = {
      success: true,
      message: "Files received successfully and are being processed",
      data: {
        bucket: bucketName,
        folderPath: folderPath || "/",
        filesReceived: files.length,
        status: "processing",
        jobId: jobId, // Return the job ID to the client
        timestamp: new Date().toISOString(),
      },
    };

    res.status(200).json(response);
    processFilesInBackground(files, bucketName, folderPath, startTime, jobId);
  } catch (error) {
    const errorTime = Date.now() - startTime;
    debugUpload(
      `[albums.js] Upload error occurred after ${errorTime}ms:`,
      {
        error: error.message,
        stack: error.stack,
      }
    );

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// DELETE /buckets/:bucketName/objects - Delete objects from a bucket
const deleteObjects = (minioClient) => async (req, res) => {
  const { bucketName } = req.params;
  const { objectName } = req.body; // Example: "TEST/01.avif"

  try {
    await minioClient.removeObject(bucketName, objectName);

    debugUpload(`[albums.js] Deleted object:`, {
      bucket: bucketName,
      object: objectName,
      user: req.user?.username || "unknown",
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      message: `Object ${objectName} deleted from ${bucketName}`,
    });
  } catch (error) {
    debugUpload(`[albums.js] Delete error:`, error);
    res.status(500).json({
      success: false,
      error: "Failed to delete object. " + error.message,
    });
  }
};

// Helper: counts objects under a given prefix (album path) in MinIO
function countObjectsInPath(minioClient, bucket, prefix) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const stream = minioClient.listObjectsV2(bucket, prefix, true);

    stream.on("data", () => {
      count++;
    });

    stream.on("end", () => {
      resolve(count);
    });

    stream.on("error", (err) => {
      reject(err);
    });
  });
}

// Export factory function that accepts dependencies
module.exports = (minioClient, processFilesInBackground) => {
  router.get("/albums", getAlbums(minioClient));
  router.get("/album/:name", getPhotos(minioClient));
  router.get("/objects/:name", getPhotos(minioClient));
  router.get("/albums/:name/object/:object", getObject(minioClient));
  
  // Upload routes - now in albums.js
  router.post("/buckets/:bucketName/upload", 
    authenticateToken, 
    upload.array("files"), 
    uploadFiles(minioClient, processFilesInBackground)
  );
  
  router.delete("/buckets/:bucketName/objects", 
    authenticateToken, 
    deleteObjects(minioClient)
  );
  
  return router;
};