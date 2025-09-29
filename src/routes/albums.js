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
  try {
    const { folderPath } = req.params;
    const { description, month, year } = req.body;

    // Clean the folder path: remove leading/trailing slashes, then ensure it ends with /
    let cleanPath = folderPath.trim();
    cleanPath = cleanPath.replace(/^\/+/, ""); // Remove leading slashes
    cleanPath = cleanPath.replace(/\/+$/, ""); // Remove trailing slashes
    cleanPath = cleanPath.replace(/\/+/g, "/"); // Replace multiple slashes with single slash

    if (!cleanPath) {
      return res.status(400).json({
        success: false,
        error: "Invalid album name",
      });
    }

    const normalizedPath = `${cleanPath}/`;

    const existingObjects = [];
    const stream = minioClient.listObjectsV2(
      process.env.MINIO_BUCKET_NAME,
      normalizedPath,
      false
    );

    for await (const obj of stream) {
      existingObjects.push(obj);
      break; // We only need to check if any object exists with this prefix
    }

    if (existingObjects.length > 0) {
      return res.status(409).json({
        success: false,
        error: "Album already exists",
      });
    }

    // Instead of creating an empty folder marker, create a metadata JSON file
    // This serves as both the folder marker and metadata storage
    const metadataPath = `${normalizedPath}${cleanPath}.json`;

    const initialMetadata = {
      album: {
        name: cleanPath,
        created: new Date().toISOString(),
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

    let mariaCreate = await database.createAlbum({
      name: cleanPath,
      path: normalizedPath,
      description: description || "",
      month: month || null,
      year: year || null,
    });

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

      let result = {
        name: obj.name,
        size: obj.size,
        lastModified: obj.lastModified,
        etag: obj.etag,
        type: "file",
      };

      objects.push(result);
    }
    

    res.json({
      success: true,
      album: {
        ...album,
        objects: objects,
        objectCount: objects.length,
      },
    });
  } catch (error) {
    console.error("[(206) albums.js] Error:", error.message);
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

    const album = await database.getAlbumByName(name);
    if (!album) {
      return res.status(404).json({ success: false, error: "Album not found" });
    }

    const objectKey = `${album.path}${object}`;

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
      res.status(500).json({ success: false, error: err.message });
    });
  } catch (error) {
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

    if (!files || files.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No files provided",
      });
    }

    debugUpload(`[albums.js (273)] Upload request received for ${files.length} files to folder: ${folderPath} with jobId: ${jobId}`);

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
    processFilesInBackground(
      files,
      config.minio.bucketName,
      folderPath,
      startTime,
      jobId
    );
  } catch (error) {
    const errorTime = Date.now() - startTime;

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

    // Extract folder name from the path to construct correct metadata path
    const pathParts = folderPath.split("/");
    const folderName = pathParts[pathParts.length - 1];
    const metadataPath = `${folderPath}/${folderName}.json`;

    try {
      // Try to read and update the metadata file
      const metadataStream = await minioClient.getObject(
        config.minio.bucketName,
        metadataPath
      );
      let metadata = "";
      for await (const chunk of metadataStream) {
        metadata += chunk.toString();
      }

      const metadataJson = JSON.parse(metadata);

      // Remove the object from the media array using sourceImage field
      const originalLength = metadataJson.media.length;
      metadataJson.media = metadataJson.media.filter(
        (item) => item.sourceImage !== objectName
      );

      // Update lastUpdated timestamp
      metadataJson.lastUpdated = new Date().toISOString();

      // Only update if we actually removed something
      if (metadataJson.media.length < originalLength) {
        const updatedMetadata = Buffer.from(
          JSON.stringify(metadataJson, null, 2)
        );
        await minioClient.putObject(
          config.minio.bucketName,
          metadataPath,
          updatedMetadata,
          updatedMetadata.length,
          {
            "Content-Type": "application/json",
          }
        );
      } else {
        //debugUpload(`[albums.js] Object ${objectName} not found in metadata, skipping metadata update`);
      }
    } catch (metadataError) {
      // If metadata file doesn't exist or can't be read, log it but don't fail the deletion
      //debugUpload(`[albums.js] Metadata update failed (non-critical): ${metadataError.message}`);
    }

    res.status(200).json({
      success: true,
      message: `Object ${objectName} deleted from ${config.minio.bucketName}`,
      data: {
        deletedObject: objectName,
        objectPath: objectPath,
        metadataUpdated: true,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to delete object. " + error.message,
    });
  }
};

// PUT /buckets/:bucketName/objects - Update photo metadata in the album JSON file
const updatePhotoMetadata = (minioClient) => async (req, res) => {
  debugAlbum(
    `[albums.js] Update photo metadata request received: ${JSON.stringify(
      req.params
    )} with body: ${JSON.stringify(req.body)}`
  );
  try {
    const { folderPath, objectName } = req.params;
    const { metadata } = req.body;

    if (!folderPath || !objectName || !metadata) {
      return res.status(400).json({
        success: false,
        message: "folderPath, objectName, and metadata are required.",
      });
    }

    const metadataService = new MetadataService(minioClient);

    debugAlbum(
      `[albums.js] Updating metadata for ${folderPath}/${objectName} with data: ${JSON.stringify(
        metadata
      )}`
    );

    // If coordinates are provided, attempt to find address (non-blocking)
    if (metadata.coordinates) {
      await metadataService
        .getAddressFromCoordinates(metadata.coordinates)
        .then((address) => {
          metadata.location = address;
          debugAlbum(`[albums.js (379)] METADATA ${JSON.stringify(metadata)}`);
        })
        .catch((err) => {
          console.error(`Error finding address: ${err}`);
        });
    }

    // Construct the metadata file path
    const metadataPath = `${folderPath}/${folderPath}.json`;

    try {
      // Read the current metadata file
      const metadataStream = await minioClient.getObject(
        config.minio.bucketName,
        metadataPath
      );
      let currentMetadata = "";
      for await (const chunk of metadataStream) {
        currentMetadata += chunk.toString();
      }

      const metadataJson = JSON.parse(currentMetadata);

      // Find and update the specific photo's metadata
      const photoIndex = metadataJson.media.findIndex(
        (item) => item.sourceImage === `${folderPath}/${objectName}`
      );

      if (photoIndex === -1) {
        return res.status(404).json({
          success: false,
          message: "Photo not found in metadata.",
        });
      } else {
        debugAlbum(
          `[albums.js (409)] METADATA JSON ${JSON.stringify(metadata)}`
        );
        // Update the metadata for this photo
        metadataJson.media[photoIndex] = {
          ...metadataJson.media[photoIndex],
          ...metadata,
        };
        debugAlbum(
          `[albums.js (414)] METADATA CHANGED TO >> ${JSON.stringify(
            metadataJson.media[photoIndex]
          )}`
        );
      }

      // Update the lastUpdated timestamp
      metadataJson.lastUpdated = new Date().toISOString();

      // Write the updated metadata back to MinIO
      const updatedMetadataContent = Buffer.from(
        JSON.stringify(metadataJson, null, 2)
      );
      await minioClient.putObject(
        config.minio.bucketName,
        metadataPath,
        updatedMetadataContent,
        updatedMetadataContent.length,
        {
          "Content-Type": "application/json",
        }
      );

      res.status(200).json({
        success: true,
        message: "Photo metadata updated successfully.",
        data: {
          updatedPhoto: objectName,
          metadataPath: metadataPath,
        },
      });
    } catch (metadataError) {
      console.error(`[albums.js] Error updating metadata:`, metadataError);
      return res.status(500).json({
        success: false,
        message: "Failed to update metadata file.",
        error: metadataError.message,
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

// PUT /album/:currentName - Rename an album (Admin only)
const renameAlbum = (minioClient) => async (req, res) => {
  try {
    const { currentName } = req.params;
    const { newName } = req.body;

    if (!newName || !newName.trim()) {
      return res.status(400).json({
        success: false,
        error: "New album name is required",
      });
    }

    const cleanNewName = newName.trim();
    const newNormalizedPath = `${cleanNewName}/`;

    // Check if album exists
    const album = await database.getAlbumByName(currentName);
    if (!album) {
      return res.status(404).json({
        success: false,
        error: "Album not found",
      });
    }

    // Check if new name already exists
    const existingAlbum = await database.getAlbumByName(cleanNewName);
    if (existingAlbum) {
      return res.status(409).json({
        success: false,
        error: "Album with this name already exists",
      });
    }

    // Check if new path already exists in MinIO
    const existingObjects = [];
    const stream = minioClient.listObjectsV2(
      process.env.MINIO_BUCKET_NAME,
      newNormalizedPath,
      false
    );
    for await (const obj of stream) {
      existingObjects.push(obj);
      break; // We only need to check if any object exists with this prefix
    }

    if (existingObjects.length > 0) {
      return res.status(409).json({
        success: false,
        error: "Album path already exists in storage",
      });
    }

    const oldPath = album.path;
    const oldMetadataPath = `${oldPath}${currentName}.json`;
    const newMetadataPath = `${newNormalizedPath}${cleanNewName}.json`;

    // Start transaction-like operation for MinIO
    try {
      // 1. Read current metadata
      const metadataStream = await minioClient.getObject(
        config.minio.bucketName,
        oldMetadataPath
      );
      let metadata = "";
      for await (const chunk of metadataStream) {
        metadata += chunk.toString();
      }
      const metadataJson = JSON.parse(metadata);

      // 2. Update metadata with new album name
      metadataJson.album.name = cleanNewName;
      metadataJson.lastUpdated = new Date().toISOString();

      // 3. Update media paths in metadata (sourceImage fields)
      metadataJson.media = metadataJson.media.map((item) => ({
        ...item,
        sourceImage: item.sourceImage.replace(oldPath, newNormalizedPath),
      }));

      // 4. List all objects in the old album path
      const objectsToMove = [];
      const listStream = minioClient.listObjectsV2(
        config.minio.bucketName,
        oldPath,
        true
      );
      for await (const obj of listStream) {
        objectsToMove.push(obj);
      }

      // 5. Copy all objects to new path (EXCLUDING the old metadata file)
      for (const obj of objectsToMove) {
        // Skip the old metadata JSON file - we'll create a new one with updated content
        if (obj.name === oldMetadataPath) {
          continue;
        }

        const newKey = obj.name.replace(oldPath, newNormalizedPath);

        // Copy object
        await minioClient.copyObject(
          config.minio.bucketName,
          newKey,
          `${config.minio.bucketName}/${obj.name}`
        );
      }

      // 6. Put updated metadata at new location
      const updatedMetadataContent = Buffer.from(
        JSON.stringify(metadataJson, null, 2)
      );
      await minioClient.putObject(
        config.minio.bucketName,
        newMetadataPath,
        updatedMetadataContent,
        updatedMetadataContent.length,
        {
          "Content-Type": "application/json",
          "X-Amz-Meta-Type": "album-metadata",
        }
      );

      // 7. Update database
      const updateResult = await database.updateAlbumDescription(album.id, {
        name: cleanNewName,
        path: newNormalizedPath,
        description: album.description, // Keep existing description
      });

      if (!updateResult) {
        throw new Error("Failed to update album in database");
      }

      // 8. Delete old objects (only after successful copy and DB update)
      for (const obj of objectsToMove) {
        await minioClient.removeObject(config.minio.bucketName, obj.name);
      }

      res.status(200).json({
        success: true,
        message: `Album '${currentName}' renamed to '${cleanNewName}' successfully`,
        data: {
          oldName: currentName,
          newName: cleanNewName,
          oldPath: oldPath,
          newPath: newNormalizedPath,
          objectsMoved: objectsToMove.length,
        },
      });
    } catch (minioError) {
      console.error(
        "[albums.js] MinIO operation failed during rename:",
        minioError
      );
      // Note: In a production system, you might want to implement rollback logic here
      // For now, we'll return the error and let the admin handle cleanup if needed
      res.status(500).json({
        success: false,
        error: `Storage operation failed: ${minioError.message}`,
      });
    }
  } catch (error) {
    console.error("[albums.js] Rename album error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
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
  router.put(
    "/album/:currentName",
    authenticateToken,
    requireRole("admin"),
    renameAlbum(minioClient)
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
