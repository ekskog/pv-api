// routes/albums.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { authenticateToken, requireRole } = require("../middleware/authMW");

const database = require("../services/database-service");
const MetadataService = require("../services/metadata-service");

const config = require("../config");

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
        console.log(`[albums.js line 40] Fetching file count for album: ${album.name}`);
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

// POST /buckets/:bucketName/folders - Create a folder (Admin only)
const createAlbum = (minioClient) => async (req, res) => {
  debugAlbum(`[albums.js line 58] Create album request received: `, req.body);
  try {
    const { folderPath } = req.params;
    console.log(`[albums.js line 60] Creating album: ${folderPath}`);

    // Clean the folder path: remove leading/trailing slashes, then ensure it ends with /
    let cleanPath = folderPath.trim();
    cleanPath = cleanPath.replace(/^\/+/, ""); // Remove leading slashes
    cleanPath = cleanPath.replace(/\/+$/, ""); // Remove trailing slashes
    cleanPath = cleanPath.replace(/\/+/g, "/"); // Replace multiple slashes with single slash

    if (!cleanPath) {
      debugAlbum(`[album.js LINE 68]: ERROR: Invalid album name after cleaning`);
      return res.status(400).json({
        success: false,
        error: "Invalid album name",
      });
    }

    const normalizedPath = `${cleanPath}/`;
    debugAlbum(`[server.js LINE 76]: Final normalized path: "${normalizedPath}"`);

    const existingObjects = [];
    const stream = minioClient.listObjectsV2(process.env.MINIO_BUCKET_NAME, normalizedPath, false);

    for await (const obj of stream) {
      existingObjects.push(obj);
      break; // We only need to check if any object exists with this prefix
    }

    if (existingObjects.length > 0) {
      debugAlbum(
        `[album.js LINE 92]: ERROR: Album already exists (${existingObjects.length} objects found)`
      );
      return res.status(409).json({
        success: false,
        error: "Album already exists",
      });
    }

    // Instead of creating an empty folder marker, create a metadata JSON file
    // This serves as both the folder marker and metadata storage
    const metadataPath = `${normalizedPath}${cleanPath}.json`;
    debugAlbum(`[albums.js line 100] Creating metadata file: ${metadataPath}`);

    const initialMetadata = {
      album: {
        name: cleanPath,
        created: new Date().toISOString(),
        description: "",
        totalObjects: 0,
        totalSize: 0,
        lastModified: new Date().toISOString(),
      },
      media: [],
    };

    const metadataContent = Buffer.from(
      JSON.stringify(initialMetadata, null, 2)
    );

    let minIoCreate = await minioClient.putObject(
      config.minio.bucketName,
      metadataPath,
      metadataContent,
      metadataContent.length,
      {
        "Content-Type": "application/json",
        "X-Amz-Meta-Type": "album-metadata",
      }
    );

    debugAlbum(`[albums.js line 132] Creating new folderPath in MinIO: ${minIoCreate}`);

    let mariaCreate = await database.createAlbum({
      name: cleanPath,
      path: normalizedPath,
      description: "",
    });

    debugAlbum(`[albums.js line 140] Creating new row in MariaDB: ${mariaCreate}`);

    res.status(201).json({
      success: true,
      message: `Folder '${cleanPath}' created successfully`,
      data: {
        bucket: config.minio.bucketName,
        folderPath: normalizedPath,
        folderName: cleanPath,
      },
    });
  } catch (error) {
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
    debugAlbum(
      `[albums.js - line 113] Fetching object "${object}" for album: ${name}`
    );

    const album = await database.getAlbumByName(name);
    if (!album) {
      return res.status(404).json({ success: false, error: "Album not found" });
    }

    const objectKey = `${album.path}${object}`;
    debugMinio(`[albums.js] Fetching MinIO object: ${objectKey}`);

    // Get object metadata first (for headers like content-type, length)
    const stat = await minioClient.statObject(
      config.minio.bucketName,
      objectKey
    );

    // Set response headers
    res.setHeader(
      "Content-Type",
      stat.metaData["content-type"] || "application/octet-stream"
    );
    res.setHeader("Content-Length", stat.size);
    res.setHeader("ETag", stat.etag);

    // Stream object to response
    const stream = await minioClient.getObject(
      config.minio.bucketName,
      objectKey
    );
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
const uploadFiles = (processFilesInBackground) => async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4(); // Generate unique job ID for this upload

  try {
    const { folderPath = "" } = req.body;
    const files = req.files;

    debugUpload(`[albums.js] Upload request received:`, {
      jobId,
      bucket: config.minio.bucketName,
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
        bucket: config.minio.bucketName,
        folderPath: folderPath || "/",
        filesReceived: files.length,
        status: "processing",
        jobId: jobId, // Return the job ID to the client
        timestamp: new Date().toISOString(),
      },
    };

    res.status(200).json(response);
    processFilesInBackground(files, config.minio.bucketName, folderPath, startTime, jobId);
  } catch (error) {
    const errorTime = Date.now() - startTime;
    debugUpload(`[albums.js] Upload error occurred after ${errorTime}ms:`, {
      error: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// DELETE /buckets/:bucketName/objects - Delete objects from a bucket
const deleteObjects = (minioClient) => async (req, res) => {
  const folderPath = req.params.folderPath;
  const objectName = req.params.objectName;
  const objectPath = `${folderPath}/${objectName}`;

  try {
    // Delete the object from MinIO
    await minioClient.removeObject(config.minio.bucketName, objectPath);
    debugUpload(`[albums.js] Deleted object from MinIO: ${objectPath}`);

    // Extract folder name from the path to construct correct metadata path
    const pathParts = folderPath.split('/');
    const folderName = pathParts[pathParts.length - 1];
    const metadataPath = `${folderPath}/${folderName}.json`;

    try {
      // Try to read and update the metadata file
      const metadataStream = await minioClient.getObject(config.minio.bucketName, metadataPath);
      let metadata = "";
      for await (const chunk of metadataStream) {
        metadata += chunk.toString();
      }

      const metadataJson = JSON.parse(metadata);

      // Remove the object from the media array using sourceImage field
      const originalLength = metadataJson.media.length;
      metadataJson.media = metadataJson.media.filter((item) => item.sourceImage !== objectName);

      // Update lastUpdated timestamp
      metadataJson.lastUpdated = new Date().toISOString();

      // Only update if we actually removed something
      if (metadataJson.media.length < originalLength) {
        const updatedMetadata = Buffer.from(JSON.stringify(metadataJson, null, 2));
        await minioClient.putObject(
          config.minio.bucketName,
          metadataPath,
          updatedMetadata,
          updatedMetadata.length,
          {
            "Content-Type": "application/json",
          }
        );
        debugUpload(`[albums.js] Updated metadata file: ${metadataPath}`);
      } else {
        debugUpload(`[albums.js] Object ${objectName} not found in metadata, skipping metadata update`);
      }

    } catch (metadataError) {
      // If metadata file doesn't exist or can't be read, log it but don't fail the deletion
      debugUpload(`[albums.js] Metadata update failed (non-critical): ${metadataError.message}`);
    }

    debugUpload(`[albums.js] Successfully deleted object:`, {
      bucket: config.minio.bucketName,
      object: objectName,
      objectPath: objectPath,
      user: req.user?.username || "admin",
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      message: `Object ${objectName} deleted from ${config.minio.bucketName}`,
      data: {
        deletedObject: objectName,
        objectPath: objectPath,
        metadataUpdated: true
      }
    });
  } catch (error) {
    debugUpload(`[albums.js] Delete error:`, error);
    res.status(500).json({
      success: false,
      error: "Failed to delete object. " + error.message,
    });
  }
};

// Update photo metadata in the album JSON file
const updatePhotoMetadata = (minioClient) => async (req, res) => {
  try {
    const { folderPath, objectName } = req.params;
    const { metadata } = req.body;

    if (!folderPath || !objectName || !metadata) {
      return res.status(400).json({
        success: false,
        message: "folderPath, objectName, and metadata are required."
      });
    }

    console.log(`[albums.js] Updating metadata for: ${folderPath}/${objectName}`);
    console.log(metadata.coordinates)
    const metadataService = new MetadataService(minioClient);

    await metadataService.getAddressFromCoordinates(metadata.coordinates)
      .then(address => {
        console.log(`Address found: ${address}`);
      })
      .catch(err => {
        console.error(`Error finding address: ${err}`);
      });

    // Construct the metadata file path
    const metadataPath = `${folderPath}/${folderPath}.json`;

    try {
      // Read the current metadata file
      const metadataStream = await minioClient.getObject(config.minio.bucketName, metadataPath);
      let currentMetadata = "";
      for await (const chunk of metadataStream) {
        currentMetadata += chunk.toString();
      }

      const metadataJson = JSON.parse(currentMetadata);

      // Find and update the specific photo's metadata
      const photoIndex = metadataJson.media.findIndex(item => item.sourceImage === `${folderPath}/${objectName}`);

      if (photoIndex === -1) {
        return res.status(404).json({
          success: false,
          message: "Photo not found in metadata."
        });
      }

      // Update the metadata for this photo
      metadataJson.media[photoIndex] = {
        ...metadataJson.media[photoIndex],
        ...metadata
      };

      // Update the lastUpdated timestamp
      metadataJson.lastUpdated = new Date().toISOString();

      // Write the updated metadata back to MinIO
      const updatedMetadataContent = Buffer.from(JSON.stringify(metadataJson, null, 2));
      await minioClient.putObject(
        config.minio.bucketName,
        metadataPath,
        updatedMetadataContent,
        updatedMetadataContent.length,
        {
          "Content-Type": "application/json",
        }
      );

      console.log(`[albums.js] Successfully updated metadata for ${objectName}`);

      res.status(200).json({
        success: true,
        message: "Photo metadata updated successfully.",
        data: {
          updatedPhoto: objectName,
          metadataPath: metadataPath
        }
      });

    } catch (metadataError) {
      console.error(`[albums.js] Error updating metadata:`, metadataError);
      return res.status(500).json({
        success: false,
        message: "Failed to update metadata file.",
        error: metadataError.message
      });
    }

  } catch (error) {
    console.error(`[albums.js] Update metadata error:`, error);
    res.status(500).json({
      success: false,
      error: "Failed to update photo metadata. " + error.message,
    });
  }
};

// Consolidate the module.exports into a single export
module.exports = (minioClient, processFilesInBackground) => {
  router.get("/albums", getAlbums(minioClient));
  router.get("/album/:name", getPhotos(minioClient));
  router.get("/objects/:name", getPhotos(minioClient));
  router.get("/albums/:name/object/:object", getObject(minioClient));
  router.post(
    "/buckets/:bucketName/upload",
    authenticateToken,
    requireRole("admin"),
    upload.array("files"),
    uploadFiles(processFilesInBackground)
  );
  router.post(
    "/album/:folderPath",
    authenticateToken,
    requireRole("admin"),
    createAlbum(minioClient)
  );
  router.delete(
    "/objects/:folderPath/:objectName",
    authenticateToken,
    requireRole("admin"),
    deleteObjects(minioClient)
  );
  router.put(
    "/objects/:folderPath/:objectName",
    authenticateToken,
    requireRole("admin"),
    updatePhotoMetadata(minioClient)
  );

  return router;
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
