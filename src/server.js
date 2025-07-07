require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Client } = require("minio");

// Import authentication components
const database = require("./config/database");
const authRoutes = require("./routes/auth");
const { authenticateToken, requireRole } = require("./middleware/auth");

// Import services
const UploadService = require("./services/upload-service");
const AvifConverterService = require("./services/avif-converter-service");
const MetadataService = require("./services/metadata-service");
const redisService = require("./services/redis-service");
const jobService = require("./services/job-service");

const app = express();
const PORT = process.env.PORT || 3001;

// CORS Configuration - Allow frontend domain
const corsOptions = {
  origin: [
    "https://photos.hbvu.su",
    "http://localhost:5173", // For development
    "http://localhost:3000", // Alternative dev port
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-auth-token"],
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: "2gb" })); // Increased for video uploads
app.use(express.urlencoded({ limit: "2gb", extended: true })); // Increased for video uploads

// Initialize database connection if not in demo mode
async function initializeDatabase() {
  const authMode = process.env.AUTH_MODE || "demo";

  if (authMode === "database") {
    try {
      await database.initialize();
    } catch (error) {
      console.error("Database initialization failed:", error.message);
      process.env.AUTH_MODE = "demo";
    }
  } else {
    //console.log('Running in demo authentication mode')
  }
}

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB limit for large video files from iPhone
  },
});

// MinIO Client Configuration
const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: parseInt(process.env.MINIO_PORT),
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});

console.log("🔧 MinIO Configuration:", {
  endPoint: process.env.MINIO_ENDPOINT,
  port: process.env.MINIO_PORT,
  useSSL: process.env.MINIO_USE_SSL,
  accessKey: process.env.MINIO_ACCESS_KEY
    ? `${process.env.MINIO_ACCESS_KEY.substring(0, 4)}***`
    : "NOT_SET",
  secretKeySet: !!process.env.MINIO_SECRET_KEY,
});

console.log("🔧 AVIF Converter Configuration:", {
  url: process.env.AVIF_CONVERTER_URL,
  timeout: process.env.AVIF_CONVERTER_TIMEOUT,
});

// Initialize Upload Service
const uploadService = new UploadService(minioClient);

// Initialize Metadata Service
const metadataService = new MetadataService(minioClient);

// Initialize AVIF Converter Service (Step 2: Test integration)
const avifConverterService = new AvifConverterService();

async function countAlbums(bucketName) {
  return new Promise((resolve, reject) => {
    const folderSet = new Set();

    const objectsStream = minioClient.listObjectsV2(bucketName, "", true);

    objectsStream.on("data", (obj) => {
      const key = obj.name;
      const topLevelPrefix = key.split("/")[0];
      if (key.includes("/")) {
        folderSet.add(topLevelPrefix);
      }
    });

    objectsStream.on("end", () => {
      const albums = [...folderSet];
      console.log(`Number of top-level folders: ${albums.length}`);
      console.log(albums);
      resolve(albums);
    });

    objectsStream.on("error", (err) => {
      console.error("Error listing objects:", err);
      reject(err);
    });
  });
}
// Test route
app.get("/", (req, res) => {
  const authMode = process.env.AUTH_MODE || "demo";
  res.json({
    message: "PhotoVault API is running!",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    authMode: authMode,
  });
});

// Authentication routes
app.use("/auth", authRoutes);

// Health check route
app.get("/health", async (req, res) => {
  //console.log(`[HEALTH] Health check request received from ${req.ip} at ${new Date().toISOString()}`)
  try {
    //console.log('[HEALTH] Testing MinIO connection...')
    // Test MinIO connection by listing albums
    const albums = await countAlbums(process.env.MINIO_BUCKET_NAME);
    console.log(
      `[HEALTH] MinIO connection successful, found ${albums.length} album`
    );

    //console.log('[HEALTH] Testing Redis connection...')
    // Test Redis connection
    const redisStatus = await redisService.getConnectionStatus();
    console.log(
      `[HEALTH] Redis connection status: ${
        redisStatus.connected ? "connected" : "disconnected"
      }`
    );

    const healthStatus = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      minio: {
        connected: true,
        albums: albums.length,
        endpoint: process.env.MINIO_ENDPOINT,
      },
      redis: redisStatus,
    };

    // If Redis is not connected, still return healthy but with warning
    if (!redisStatus.connected) {
      healthStatus.status = "degraded";
      healthStatus.warnings = [
        "Redis connection unavailable - async uploads will be disabled",
      ];
    }

    //console.log('[HEALTH] Sending healthy response')
    res.json(healthStatus);
  } catch (error) {
    console.error(`[HEALTH] Error during health check: ${error.message}`);
    const redisStatus = await redisService.getConnectionStatus();

    //console.log('[HEALTH] Sending unhealthy response')
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      minio: {
        connected: false,
        error: error.message,
      },
      redis: redisStatus,
    });
  }
});

// GET /albums - List all albums (public access for album browsing)
app.get("/albums", async (req, res) => {
  try {
    const folderSet = new Set();

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
      console.log(`Number of top-level folders: ${folderSet.size}`);
      console.log([...folderSet]);
    });

    objectsStream.on("error", (err) => {
      console.error("Error listing objects:", err);
    });
    res.json({
      success: true,
      data: albums,
      count: albums.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/buckets/:bucketName/objects", async (req, res) => {
  try {
    const { bucketName } = req.params;
    const { prefix = "", recursive = "false" } = req.query;

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
    const isRecursive = recursive === "true";

    // For recursive: use listObjects with recursive=true, no delimiter
    // For non-recursive: use listObjectsV2 with delimiter to show folders
    let stream;

    if (isRecursive) {
      // Recursive listing - get all objects
      stream = minioClient.listObjects(bucketName, prefix, true);

      for await (const obj of stream) {
        // Skip metadata JSON files from the listing
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
    } else {
      // Non-recursive listing - show folder structure
      stream = minioClient.listObjectsV2(bucketName, prefix, false, "/");

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
    }

    const responseData = {
      success: true,
      data: {
        bucket: bucketName,
        prefix: prefix || "/",
        recursive: isRecursive,
        folders: folders,
        objects: objects,
        totalFolders: folders.length,
        totalObjects: objects.length,
      },
    };


    res.json(responseData);
  } catch (error) {
    // debugService.server.error('Error in GET /buckets/:bucketName/objects:', error.message)
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /buckets/:bucketName/folders - Create a folder (Admin only)
app.post(
  "/buckets/:bucketName/folders",
  authenticateToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { bucketName } = req.params;
      const { folderPath } = req.body;

      if (!folderPath) {
        return res.status(400).json({
          success: false,
          error: "Folder path is required",
        });
      }

      // Check if bucket exists
      const bucketExists = await minioClient.bucketExists(bucketName);
      if (!bucketExists) {
        return res.status(404).json({
          success: false,
          error: "Bucket not found",
        });
      }

      // Clean the folder path: remove leading/trailing slashes, then ensure it ends with /
      let cleanPath = folderPath.trim();
      cleanPath = cleanPath.replace(/^\/+/, ""); // Remove leading slashes
      cleanPath = cleanPath.replace(/\/+$/, ""); // Remove trailing slashes
      cleanPath = cleanPath.replace(/\/+/g, "/"); // Replace multiple slashes with single slash

      if (!cleanPath) {
        return res.status(400).json({
          success: false,
          error: "Invalid folder path",
        });
      }

      const normalizedPath = `${cleanPath}/`;

      // Check if folder already exists by looking for any objects with this prefix
      const existingObjects = [];
      const stream = minioClient.listObjectsV2(
        bucketName,
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
          error: "Folder already exists",
        });
      }

      // Instead of creating an empty folder marker, create a metadata JSON file
      // This serves as both the folder marker and metadata storage
      const metadataPath = `${normalizedPath}${cleanPath}.json`;
      const initialMetadata = {
        album: {
          name: cleanPath,
          created: new Date().toISOString(),
          description: "",
          totalPhotos: 0,
          totalSize: 0,
          lastModified: new Date().toISOString(),
        },
        photos: [],
      };

      const metadataContent = Buffer.from(
        JSON.stringify(initialMetadata, null, 2)
      );

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

      res.status(201).json({
        success: true,
        message: `Folder '${cleanPath}' created successfully`,
        data: {
          bucket: bucketName,
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
  }
);

// Background processing function for asynchronous uploads
async function processFilesInBackground(files, bucketName, folderPath, startTime) {
  try {
    console.log(`[UPLOAD_BG] Starting background processing for ${files.length} files`);
    
    const { results: uploadResults, errors } =
      await uploadService.processMultipleFiles(files, bucketName, folderPath);

    const processingTime = Date.now() - startTime;
    console.log(`[UPLOAD_BG] Background processing complete in ${processingTime}ms:`, {
      totalFilesProcessed: files.length,
      successfulUploads: uploadResults.length,
      failedUploads: errors.length
    });

    if (uploadResults.length > 0) {
      console.log('[UPLOAD_BG] Successfully uploaded files:', uploadResults.map((result, index) => 
        `${index + 1}. ${result.objectName} (${(result.size / 1024 / 1024).toFixed(2)}MB, ${result.mimetype})`
      ));
    }

    if (errors.length > 0) {
      console.error(
        "[UPLOAD_BG] Failed uploads:",
        errors.map(
          (error, index) => `${index + 1}. ${error.filename}: ${error.error}`
        )
      );
    }

    console.log('[UPLOAD_BG] Background processing completed');
  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error(`[UPLOAD_BG] Background processing error after ${errorTime}ms:`, {
      error: error.message,
      stack: error.stack,
    });
  }
}

// POST /buckets/:bucketName/upload - Upload file(s) to a bucket with optional folder path
app.post(
  "/buckets/:bucketName/upload",
  authenticateToken,
  upload.array("files"),
  async (req, res) => {
    const startTime = Date.now();

    try {
      const { bucketName } = req.params;
      const { folderPath = "" } = req.body;
      const files = req.files;

      console.log(`[UPLOAD] Upload request received:`, {
        bucket: bucketName,
        folder: folderPath,
        filesCount: files ? files.length : 0,
        user: req.user?.username || 'unknown',
        timestamp: new Date().toISOString()
      });

      if (!files || files.length === 0) {
        console.error('[UPLOAD] Upload failed: No files provided')
        return res.status(400).json({
          success: false,
          error: 'No files provided'
        })
      }

      console.log('[UPLOAD] Files to upload:', files.map((file, index) => 
        `${index + 1}. ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)}MB, ${file.mimetype})`
      ));

      // Check if bucket exists
      console.log(`[UPLOAD] Checking if bucket '${bucketName}' exists...`)
      const bucketExists = await minioClient.bucketExists(bucketName);
      if (!bucketExists) {
        console.error(
          `[UPLOAD] Upload failed: Bucket '${bucketName}' not found`
        );
        return res.status(404).json({
          success: false,
          error: "Bucket not found",
        });
      }

      console.log(`[UPLOAD] Bucket '${bucketName}' exists - proceeding with asynchronous upload processing`)

      // **ASYNCHRONOUS PROCESSING - Return immediately, process in background**
      
      // Return success immediately to user
      const response = {
        success: true,
        message: "Files received successfully and are being processed",
        data: {
          bucket: bucketName,
          folderPath: folderPath || "/",
          filesReceived: files.length,
          status: "processing",
          timestamp: new Date().toISOString()
        }
      };

      console.log(`[UPLOAD] Returning immediate response to user:`, {
        statusCode: 200,
        filesReceived: files.length,
        totalTime: `${Date.now() - startTime}ms`
      });

      res.status(200).json(response);

      // Now process files in background (no await - fire and forget)
      processFilesInBackground(files, bucketName, folderPath, startTime);
    } catch (error) {
      const errorTime = Date.now() - startTime;
      console.error(`[UPLOAD] Upload error occurred after ${errorTime}ms:`, {
        error: error.message,
        stack: error.stack,
      });
      console.error("[UPLOAD] Upload request failed");

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// GET /buckets/:bucketName/download - Get/download a specific object (Public access for images)
app.get("/buckets/:bucketName/download", async (req, res) => {
  try {
    const { bucketName } = req.params;
    const { object } = req.query;

    if (!object) {
      return res.status(400).json({
        success: false,
        error: "Object name is required",
      });
    }

    // Check if bucket exists
    const bucketExists = await minioClient.bucketExists(bucketName);
    if (!bucketExists) {
      return res.status(404).json({
        success: false,
        error: "Bucket not found",
      });
    }

    // Get object metadata first to check if it exists
    let objectStat;
    try {
      objectStat = await minioClient.statObject(bucketName, object);
    } catch (error) {
      if (error.code === "NotFound") {
        return res.status(404).json({
          success: false,
          error: "Object not found",
        });
      }
      throw error;
    }

    // Stream the object directly to the response
    const objectStream = await minioClient.getObject(bucketName, object);

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
});

// Supported file types endpoint
app.get("/supported-formats", (req, res) => {
  res.json({
    success: true,
    data: {
      images: {
        regular: ["jpg", "jpeg", "png", "webp", "tiff", "tif", "bmp"],
        heic: ["heic", "heif"],
      },
      videos: [
        "mov",
        "mp4",
        "m4v",
        "avi",
        "mkv",
        "webm",
        "flv",
        "wmv",
        "3gp",
        "m2ts",
        "mts",
      ],
      maxFileSizes: {
        images: "100MB",
        videos: "2GB",
        other: "500MB",
      },
      processing: {
        images: "Converted to AVIF variants",
        heic: "Converted to AVIF variants",
        videos: "Stored as-is (no conversion)",
        other: "Stored as-is",
      },
    },
  });
});

// Start server with database initialization
async function startServer() {
  try {
    // Initialize database connection
    await initializeDatabase();

    // Initialize Redis connection (still used for other features if available)
    console.log('Initializing Redis connection...')
    await redisService.connect();

    // Start HTTP server
    app.listen(PORT, () => {
      const authMode = process.env.AUTH_MODE || "demo";
      console.log(`\nStarting PhotoVault ${new Date()}...`)
      console.log(`PhotoVault API server running on port ${PORT}`)
      console.log(`Health check: http://localhost:${PORT}/health`)
      console.log(`Authentication: http://localhost:${PORT}/auth/status`)
      console.log(`MinIO endpoint: ${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`)
      console.log(`Auth Mode: ${authMode}`)

      if (authMode === "demo") {
        console.log('Demo users available: admin/admin123, user/user123')
      }
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log('Shutting down server...')
  if (process.env.AUTH_MODE === "database") {
    await database.close();
  }
  await redisService.disconnect();
  process.exit(0);
});

// Start the server
startServer();
