require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const debug = require("debug");
const { Client } = require("minio");
const { v4: uuidv4 } = require("uuid");

// Import authentication components
const database = require("./config/database");
const authRoutes = require("./routes/auth");
const { authenticateToken, requireRole } = require("./middleware/auth");

// Debug namespaces
const debugServer = debug("photovault:server");
const debugSSE = debug("photovault:sse");
const debugHealth = debug("photovault:health");
const debugUpload = debug("photovault:upload");
const debugMinio = debug("photovault:minio");
const debugAuth = debug("photovault:auth");
const debugAlbum = debug("photovault:album");
const debugEndpoints = debug("photovault:endpoints");

// Store active SSE connections by job ID
const sseConnections = new Map();

const sendSSEEvent = (jobId, eventType, data) => {
  const connection = sseConnections.get(jobId);
  if (!connection) {
    debugSSE(`No connection found for job ${jobId}`);
    return;
  }

  const eventData = {
    type: eventType,
    timestamp: new Date().toISOString(),
    ...data,
  };

  const message = `data: ${JSON.stringify(eventData)}\n\n`;

  try {
    connection.write(message);
    debugSSE(`LINE 46 - Event ${message} sent successfully to job ${jobId}`);
  } catch (error) {
    debugSSE(`Error sending to job ${jobId}: ${error.message}`);
    // Remove failed connection
    sseConnections.delete(jobId);
  }
};

// Import services
const UploadService = require("./services/upload-service");

const app = express();
const PORT = process.env.PORT;

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

// MinIO Client Configuration
const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: parseInt(process.env.MINIO_PORT),
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB limit for large video files from iPhone
  },
});

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: "2gb" })); // Increased for video uploads
app.use(express.urlencoded({ limit: "2gb", extended: true })); // Increased for video uploads
app.use("/auth", authRoutes);

// Initialize Services
const uploadService = new UploadService(minioClient);

// Health check route
app.get("/health", async (req, res) => {
  debugEndpoints("get /health");
  debugHealth(`Health check from ${req.ip} at ${new Date().toISOString()}`);

  let minioHealthy = false;
  let converterHealthy = false;
  let albumsCount = 0;

  // MinIO check
  try {
    const albums = await countAlbums(process.env.MINIO_BUCKET_NAME);
    albumsCount = albums.length;
    minioHealthy = true;
    debugHealth(`MinIO healthy, ${albumsCount} albums`);
  } catch (error) {
    debugHealth(`MinIO failure: ${error.message}`);
  }

  // Converter check
  try {
    const converterUrl = process.env.AVIF_CONVERTER_URL;
    const timeout = parseInt(process.env.AVIF_CONVERTER_TIMEOUT, 10);

    debugHealth(`Checking converter at ${converterUrl}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${converterUrl}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.ok) {
      converterHealthy = true;
      debugHealth(`Converter is healthy`);
    } else {
      debugHealth(`Converter unhealthy: ${response.status}`);
    }
  } catch (error) {
    debugHealth(`Converter failure: ${error.message}`);
  }

  // Compose response
  const isHealthy = minioHealthy && converterHealthy;
  const status = isHealthy ? "healthy" : "degraded";
  const code = isHealthy ? 200 : 503;

  debugHealth(`Responding with ${status} (${code})`);
  res.status(code).json({
    status,
    timestamp: new Date().toISOString(),
    minio: {
      connected: minioHealthy,
      albums: albumsCount,
      endpoint: process.env.MINIO_ENDPOINT,
    },
    converter: {
      connected: converterHealthy,
      endpoint: process.env.AVIF_CONVERTER_URL,
    },
  });
  
});


// SSE endpoint - make sure this exists in your server
app.get("/processing-status/:jobId", (req, res) => {
  debugEndpoints("get /processing-status/:jobId");

  const jobId = req.params.jobId;
  debugSSE(`Client connecting for job ${jobId}`);

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",
  });

  // Store connection
  sseConnections.set(jobId, res);
  debugSSE(
    `Connection stored for job ${jobId}. Total connections: ${sseConnections.size}`
  );

  // Send initial connection confirmation
  const confirmationData = JSON.stringify({
    type: "connected",
    jobId,
    message: "SSE connection established",
  });

  res.write(`data: ${confirmationData}\n\n`);
  debugSSE(`Sent ${confirmationData} for job ${jobId}`);

  // Handle client disconnect
  req.on("close", () => {
    debugSSE(`Client disconnected for job ${jobId}`);
    sseConnections.delete(jobId);
  });

  req.on("error", (error) => {
    debugSSE(`Request error for job ${jobId}: ${error.message}`);
    sseConnections.delete(jobId);
  });
});

// GET /albums - List all albums (public access for album browsing)
app.get("/albums", async (req, res) => {
  debugEndpoints("get /albums");
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
      debugMinio(`Number of top-level folders: ${folderSet.size}`);
      debugMinio([...folderSet]);
    });

    objectsStream.on("error", (err) => {
      debugMinio("Error listing objects:", err);
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
});

// List objects in a bucket (Admin only)
app.get("/buckets/:bucketName/objects", async (req, res) => {
  debugEndpoints("get /buckets/:bucketName/objects");
  debugMinio(
    `Request received for bucket: ${req.params.bucketName}, prefix: ${req.query.prefix}}`
  );
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

    let stream;

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
    debugMinio("Error in GET /buckets/:bucketName/objects:", error.message);
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
    debugEndpoints("post /buckets/:bucketName/folders");
    try {
      const { bucketName } = req.params;
      const { folderPath } = req.body;

      debugAlbum(`Extracted folderPath: "${folderPath}"`);

      // Check if bucket exists
      debugAlbum(`Checking if bucket exists: ${bucketName}`);
      const bucketExists = await minioClient.bucketExists(bucketName);
      debugAlbum(`Bucket exists: ${bucketExists}`);

      // Clean the folder path: remove leading/trailing slashes, then ensure it ends with /
      let cleanPath = folderPath.trim();
      cleanPath = cleanPath.replace(/^\/+/, ""); // Remove leading slashes
      cleanPath = cleanPath.replace(/\/+$/, ""); // Remove trailing slashes
      cleanPath = cleanPath.replace(/\/+/g, "/"); // Replace multiple slashes with single slash

      if (!cleanPath) {
        debugAlbum(`ERROR: Invalid folder path after cleaning`);
        return res.status(400).json({
          success: false,
          error: "Invalid folder path",
        });
      }

      const normalizedPath = `${cleanPath}/`;
      debugAlbum(`Final normalized path: "${normalizedPath}"`);

      // Check if folder already exists by looking for any objects with this prefix
      debugAlbum(
        `Checking for existing objects with prefix: "${normalizedPath}"`
      );
      const existingObjects = [];
      const stream = minioClient.listObjectsV2(
        bucketName,
        normalizedPath,
        false
      );

      for await (const obj of stream) {
        debugAlbum(`Found existing object: ${obj.name}`);
        existingObjects.push(obj);
        break; // We only need to check if any object exists with this prefix
      }

      if (existingObjects.length > 0) {
        debugAlbum(
          `ERROR: Folder already exists (${existingObjects.length} objects found)`
        );
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
          totalObjects: 0,
          totalSize: 0,
          lastModified: new Date().toISOString(),
        },
        media: [],
      };

      const metadataContent = Buffer.from(
        JSON.stringify(initialMetadata, null, 2)
      );

      const putResult = await minioClient.putObject(
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

// POST /buckets/:bucketName/upload - Upload file(s) to a bucket
app.post(
  "/buckets/:bucketName/upload",
  authenticateToken,
  upload.array("files"),
  async (req, res) => {
    debugEndpoints("post /buckets/:bucketName/upload");
    const startTime = Date.now();
    const jobId = uuidv4(); // Generate unique job ID for this upload

    try {
      const { bucketName } = req.params;
      const { folderPath = "" } = req.body;
      const files = req.files;

      debugUpload(`Upload request received:`, {
        jobId,
        bucket: bucketName,
        folder: folderPath,
        filesCount: files ? files.length : 0,
        user: req.user?.username || "unknown",
        timestamp: new Date().toISOString(),
      });

      if (!files || files.length === 0) {
        debugUpload("Upload failed: No files provided");
        return res.status(400).json({
          success: false,
          error: "No files provided",
        });
      }

      debugUpload(
        "Files to upload:",
        files.map(
          (file, index) =>
            `${index + 1}. ${file.originalname} (${(
              file.size /
              1024 /
              1024
            ).toFixed(2)}MB, ${file.mimetype})`
        )
      );

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
      debugUpload(`Upload error occurred after ${errorTime}ms:`, {
        error: error.message,
        stack: error.stack,
      });
      debugUpload("Upload request failed");

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// GET /buckets/:bucketName/download - Get/download a specific object (Public access for images)
app.get("/buckets/:bucketName/download", async (req, res) => {
  debugEndpoints("get /buckets/:bucketName/download");
  try {
    const { bucketName } = req.params;
    const { object } = req.query;

    if (!object) {
      return res.status(400).json({
        success: false,
        error: "Object name is required",
      });
    }

    debugUpload("About to stream object:", {
      bucketName,
      object,
    });

    // Stream the object directly to the response
    const objectStream = await minioClient.getObject(bucketName, object);
    debugUpload("Object stream created successfully");

    // Retrieve object metadata
    const objectStat = await minioClient.statObject(bucketName, object);

    debugUpload("Object metadata retrieved successfully:", objectStat);

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

// Start server with database initialization
async function startServer() {
  try {
    // Initialize database connection
    await initializeDatabase();

    // Start HTTP server
    app.listen(PORT, () => {
      const authMode = process.env.AUTH_MODE || "demo";
      const k8sService =
        process.env.K8S_SERVICE_NAME || "photovault-api-service";
      const k8sNamespace = process.env.K8S_NAMESPACE || "webapps";
      const publicUrl =
        process.env.PUBLIC_API_URL || "https://vault-api.hbvu.su";
      debugServer(`Starting PhotoVault ${new Date()}...`);
      debugServer(`> PhotoVault API server running on port ${PORT}`);
      debugServer(
        `> Health check (internal): http://${k8sService}.${k8sNamespace}.svc.cluster.local:${PORT}/health`
      );
      debugServer(`Health check (public): ${publicUrl}/health`);
      debugServer(
        `> Authentication: http://${k8sService}.${k8sNamespace}.svc.cluster.local:${PORT}/auth/status`
      );
      debugServer(
        `> MinIO endpoint: ${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`
      );
      debugServer(`Auth Mode: ${authMode}`);

      if (authMode === "demo") {
        debugServer("Demo users available: admin/admin123, user/user123");
      }
    });
  } catch (error) {
    debugServer("Failed to start server:", error.message);
    process.exit(1);
  }
}

// Background processing function for asynchronous uploads
// Add detailed logging for background processing
// Background processing function for asynchronous uploads with SSE updates
async function processFilesInBackground(
  files,
  bucketName,
  folderPath,
  startTime,
  jobId
) {
  try {
    const uploadResults = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        debugUpload(
          `Processing file ${i + 1}: ${file.originalname} >> ${file.mimetype}`
        );

        // Process the individual file
        const result = await uploadService.processAndUploadFile(
          file,
          bucketName,
          folderPath
        );
        uploadResults.push(result);

        debugUpload(`Successfully processed: ${file.originalname}`);
      } catch (error) {
        debugUpload(
          `Error processing file ${file.originalname}: ${error.message}`
        );
        errors.push({
          filename: file.originalname,
          error: error.message,
        });
      }
    }

    const processingTime = Date.now() - startTime;
    debugUpload(
      `Background processing completed in ${processingTime}ms - Success: ${uploadResults.length}, Errors: ${errors.length}`
    );

    // Send single completion message
    if (errors.length === 0) {
      sendSSEEvent(jobId, "complete", {
        status: "success",
        message: `All ${files.length} files processed successfully!`,
        results: {
          uploaded: uploadResults.length,
          failed: 0,
          processingTime: processingTime,
        },
      });
    } else if (uploadResults.length === 0) {
      sendSSEEvent(jobId, "complete", {
        status: "failed",
        message: `All files failed to process. Please check the files and try again.`,
        results: {
          uploaded: 0,
          failed: errors.length,
          processingTime: processingTime,
        },
        errors: errors,
      });
    } else {
      sendSSEEvent(jobId, "complete", {
        status: "partial",
        message: `${uploadResults.length} files processed successfully, ${errors.length} failed.`,
        results: {
          uploaded: uploadResults.length,
          failed: errors.length,
          processingTime: processingTime,
        },
        errors: errors,
      });
    }

    // Clean up SSE connections after 30 seconds
    setTimeout(() => {
      debugUpload(`Cleaning up SSE connections for job ${jobId}`);
      sseConnections.delete(jobId);
    }, 300000);
  } catch (error) {
    const errorTime = Date.now() - startTime;
    debugUpload(`Background processing error after ${errorTime}ms:`, {
      error: error.message,
      stack: error.stack,
    });

    // Send error completion message
    sendSSEEvent(jobId, "complete", {
      status: "failed",
      message: `Processing failed: ${error.message}`,
      error: error.message,
    });

    // Clean up connections
    setTimeout(() => {
      sseConnections.delete(jobId);
    }, 30000);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  debugServer("Shutting down server...");
  if (process.env.AUTH_MODE === "database") {
    await database.close();
  }
  process.exit(0);
});

// Initialize database connection if not in demo mode
async function initializeDatabase() {
  const authMode = process.env.AUTH_MODE;

  if (authMode === "database") {
    try {
      await database.initialize();
    } catch (error) {
      debugAuth("Database initialization failed:", error.message);
      process.env.AUTH_MODE = "demo";
    }
  } else {
    debugAuth("Running in demo authentication mode");
  }
}

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
      debugMinio(`Number of ALBUMS: ${albums.length}`);
      debugMinio(albums);
      resolve(albums);
    });

    objectsStream.on("error", (err) => {
      debugMinio("Error listing objects:", err);
      reject(err);
    });
  });
}

// Start the server
startServer();
