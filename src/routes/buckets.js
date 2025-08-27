// routes/buckets.js
const express = require('express');
const debug = require('debug');
const { authenticateToken, requireRole } = require('../middleware/authMW');
const database = require('../services/database-service'); // Add database import

const debugMinio = debug('photovault:minio');
const debugUpload = debug('photovault:upload');
const debugBucket = debug('photovault:bucket'); // Add debug for bucket operations

const router = express.Router();

// List objects in a bucket (Admin only)
const listBucketObjects = (minioClient) => async (req, res) => {
  console.log(`Listing objects in bucket: ${req.params.bucketName}`);
  try {
    const { bucketName } = req.params;
    const { prefix = "" } = req.query;

    // Check if bucket exists
    const bucketExists = await minioClient.bucketExists(bucketName);
    if (!bucketExists) {
      return res.status(404).json({
        success: false,
        error: "Bucket not found",
      });
    }

    const objects = [];
    const folders = [];

    // Non-recursive listing - show folder structure
    const stream = minioClient.listObjectsV2(bucketName, prefix, false, "/");

    for await (const obj of stream) {
      if (obj.prefix) {
        // This is a folder/prefix
        folders.push({
          name: obj.prefix,
          type: "folder",
        });
      } else {
        // Skip metadata JSON files from the listing
        if (obj.name.endsWith(".json") && obj.name.includes("/")) {
          const pathParts = obj.name.split("/");
          const fileName = pathParts[pathParts.length - 1];
          const folderName = pathParts[pathParts.length - 2];
          if (fileName === `${folderName}.json`) {
            continue;
          }
        }

        // This is a file/object
        objects.push({
          name: obj.name,
          size: obj.size,
          lastModified: obj.lastModified,
          etag: obj.etag,
          type: "file",
        });
      }
    }

    const responseData = {
      success: true,
      data: {
        bucket: bucketName,
        prefix: prefix || "/",
        folders: folders,
        objects: objects,
        totalFolders: folders.length,
        totalObjects: objects.length,
      },
    };

    res.json(responseData);
  } catch (error) {
    debugMinio(`[buckets.js - line 76] Error in GET /buckets/:bucketName/objects:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// Create a folder (Admin only) - UPDATED WITH DATABASE INTEGRATION
const createFolder = (minioClient) => async (req, res) => {
  try {
    const { bucketName } = req.params;
    const { folderPath, description } = req.body; // Added description support

    // Clean the folder path
    let cleanPath = folderPath.trim();
    cleanPath = cleanPath.replace(/^\/+/, ""); // Remove leading slashes
    cleanPath = cleanPath.replace(/\/+$/, ""); // Remove trailing slashes
    cleanPath = cleanPath.replace(/\/+/g, "/"); // Replace multiple slashes with single slash

    if (!cleanPath) {
      debugBucket(`ERROR: Invalid folder path after cleaning`);
      return res.status(400).json({
        success: false,
        error: "Invalid folder path",
      });
    }

    const normalizedPath = `${cleanPath}/`;
    debugBucket(`[buckets.js - line 164]:Final normalized path: "${normalizedPath}"`);

    // Check if folder already exists in MinIO
    const existingObjects = [];
    const stream = minioClient.listObjectsV2(bucketName, normalizedPath, false);

    for await (const obj of stream) {
      existingObjects.push(obj);
      break; // We only need to check if any object exists with this prefix
    }

    if (existingObjects.length > 0) {
      debugBucket(`[buckets.js - line 165]: ERROR: Folder already exists (${existingObjects.length} objects found)`);
      return res.status(409).json({
        success: false,
        error: "Folder already exists",
      });
    }

    // Check if album already exists in database
    try {
      const existingAlbum = await database.getAlbumByPath(normalizedPath);
      if (existingAlbum) {
        return res.status(409).json({
          success: false,
          error: "Album with this path already exists in database",
        });
      }
    } catch (dbError) {
      console.warn("Warning: Could not check for existing album in database:", dbError.message);
      // Continue with folder creation even if DB check fails
    }

    // Create metadata JSON file
    const metadataPath = `${normalizedPath}${cleanPath}.json`;

    const initialMetadata = {
      album: {
        name: cleanPath,
        created: new Date().toISOString(),
        description: description || "",
        totalObjects: 0,
        totalSize: 0,
        lastModified: new Date().toISOString(),
      },
      media: [],
    };

    const metadataContent = Buffer.from(JSON.stringify(initialMetadata, null, 2));

    // Create the folder/metadata in MinIO
    await minioClient.putObject(
      bucketName,
      metadataPath,
      metadataContent,
      metadataContent.length,
      {
        "Content-Type": "application/json",
        "X-Amz-Meta-Type": "album-metadata",
      }
    );

    // Create album record in database
    let albumData = null;
    try {
      albumData = await database.createAlbum({
        name: cleanPath,
        path: normalizedPath,
        description: description || null,
      });
      
      debugBucket(`[buckets.js]: Album created in database with slug: ${albumData.slug}`);
    } catch (dbError) {
      console.error("Warning: Could not create album in database:", dbError.message);
      // Don't fail the whole operation if database insertion fails
      // The folder was already created in MinIO successfully
    }

    res.status(201).json({
      success: true,
      message: `Folder '${cleanPath}' created successfully`,
      data: {
        bucket: bucketName,
        folderPath: normalizedPath,
        folderName: cleanPath,
        album: albumData, // Include album data with slug if database creation succeeded
      },
    });
  } catch (error) {
    console.error("Error creating folder:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// Download/get a specific object (Public access for images)
const downloadObject = (minioClient) => async (req, res) => {
  try {
    const { bucketName } = req.params;
    const { object } = req.query;

    if (!object) {
      return res.status(400).json({
        success: false,
        error: "Object name is required",
      });
    }

    // Stream the object directly to the response
    const objectStream = await minioClient.getObject(bucketName, object);
    // Retrieve object metadata
    const objectStat = await minioClient.statObject(bucketName, object);
    
    // Set appropriate headers
    res.setHeader(
      "Content-Type",
      objectStat.metaData["content-type"] || "application/octet-stream"
    );
    res.setHeader("Content-Length", objectStat.size);
    res.setHeader("Last-Modified", objectStat.lastModified);
    res.setHeader("ETag", objectStat.etag);

    // Optional: Set Content-Disposition to download file with original name
    const filename = object.split("/").pop();
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    // Pipe the object stream to response
    objectStream.pipe(res);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// Get bucket/folder count
const getBucketCount = (minioClient) => async (req, res) => {
  try {
    const { bucketName } = req.params;
    const { prefix = "" } = req.query;

    let totalObjects = 0;
    let totalFolders = 0;

    const stream = minioClient.listObjectsV2(bucketName, prefix, false, "/");

    for await (const obj of stream) {
      const objKey = obj.name || obj.prefix;

      // Skip metadata JSON files
      if (obj.name?.endsWith(".json") && obj.name.includes("/")) {
        const parts = obj.name.split("/");
        const fileName = parts.at(-1);
        const folderName = parts.at(-2);
        if (fileName === `${folderName}.json`) continue;
      }

      if (obj.prefix) {
        totalFolders++;
      } else {
        totalObjects++;
      }
    }

    res.json({
      success: true,
      data: {
        bucket: bucketName,
        prefix: prefix || "/",
        totalObjects,
        totalFolders,
      },
    });
  } catch (error) {
    console.error("❌ Error in /count:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// Delete objects from bucket
const deleteObject = (minioClient) => async (req, res) => {
  const { bucketName } = req.params;
  const { objectName } = req.body;

  try {
    await minioClient.removeObject(bucketName, objectName);

    debugUpload("Deleted object:", {
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
    debugUpload("Delete error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete object. " + error.message,
    });
  }
};

// NEW: Get album by slug (for sharing URLs)
const getAlbumBySlug = (minioClient) => async (req, res) => {
  try {
    const { slug } = req.params;
    const album = await database.getAlbumBySlug(slug);
    
    if (!album) {
      return res.status(404).json({
        success: false,
        error: 'Album not found'
      });
    }
    
    // Optionally, you can also fetch the MinIO objects for this album
    // using the album.path to list objects in that folder
    
    res.json({
      success: true,
      album: album
    });
  } catch (error) {
    console.error('Error fetching album by slug:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// NEW: List all albums
const listAlbums = (minioClient) => async (req, res) => {
  try {
    const albums = await database.getAllAlbums();
    res.json({
      success: true,
      albums: albums
    });
  } catch (error) {
    console.error('Error fetching albums:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Export factory function that accepts dependencies
module.exports = (minioClient) => {
  // Existing routes
  router.get('/:bucketName/objects', listBucketObjects(minioClient));
  router.post('/:bucketName/folders', authenticateToken, requireRole('admin'), createFolder(minioClient));
  router.get('/:bucketName/download', downloadObject(minioClient));
  router.get('/:bucketName/count', getBucketCount(minioClient));
  router.delete('/:bucketName/objects', authenticateToken, deleteObject(minioClient));
  
  // NEW routes for album sharing
  router.get('/album/:slug', getAlbumBySlug(minioClient)); // For sharing URLs like /album/dublin-trip.25
  router.get('/albums', listAlbums(minioClient)); // List all albums
  
  return router;
};