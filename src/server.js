// force rebuild on 11/08 13:38
require("dotenv").config();
const config = require('./config'); // defaults to ./config/index.js
config.validateConfig();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const debug = require("debug");
const { Client } = require("minio");

const { v4: uuidv4 } = require("uuid");

// Import authentication components
const database = require("./services/database-service");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const healthRoutes = require("./routes/health");
const albumRoutes = require("./routes/albums");

const { authenticateToken, requireRole } = require("./middleware/authMW");

// Debug namespaces
const debugServer = debug("photovault:server");
const debugSSE = debug("photovault:sse");
const debugUpload = debug("photovault:upload");
const debugMinio = debug("photovault:minio");
const debugDB = debug("photovault:database");
const debugAlbum = debug("photovault:album");

// Store active SSE connections by job ID
const sseConnections = new Map();

const sendSSEEvent = (jobId, eventType, data = {}) => {
  const connection = sseConnections.get(jobId);
  if (!connection) {
    debugSSE(`[server.js] No connection found for job ${jobId}`);
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
    debugSSE(`[server.js] Event "${eventType}" sent to job ${jobId}`);

if (eventType === "complete") {
  // Send final message
  connection.write(`data: ${JSON.stringify(eventData)}\n\n`);

  // End the stream
  connection.end();
  sseConnections.delete(jobId);
}

  } catch (error) {
    debugSSE(`[server.js] Error sending to job ${jobId}: ${error.message}`);
    sseConnections.delete(jobId);
  }
};


// Import services
const UploadService = require("./services/upload-service");

const app = express();
const PORT = config.server.port;


// MinIO Client Configuration
let minioClient;
try {
  console.log("MinIO Client Configuration:", config.minio);

  minioClient = new Client({
    endpoint: config.minio.endpoint,
    port: parseInt(config.minio.port),
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });
} catch (err) {
  console.error("MinIO client initialization failed:", err.message);
  minioClient = null;
}

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB limit for large video files from iPhone
  },
});

// Middleware
app.use(cors(config.cors));
app.use(express.json({ limit: "2gb" })); // Increased for video uploads
app.use(express.urlencoded({ limit: "2gb", extended: true })); // Increased for video uploads


// Initialize Services
const uploadService = new UploadService(minioClient);

// SSE endpoint - make sure this exists in your server
app.get("/processing-status/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  debugSSE(`[[server.js LINE 167]: ${new Date().toISOString()}] Client connecting for job ${jobId}`);

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Transfer-Encoding": "chunked",
    "Access-Control-Allow-Headers": "Cache-Control",
  });

  // Store connection
  sseConnections.set(jobId, res);
  debugSSE(`[server.js LINE 180]: ${new Date().toISOString()}] Connection stored for job ${jobId}. Total connections: ${sseConnections.size}`);

  // Send initial connection confirmation
  const confirmationData = JSON.stringify({
    type: "connected",
    jobId,
    message: "SSE connection established",
  });

  res.write(`data: ${confirmationData}\n\n`);
  debugSSE(`[[server.js LINE 190]: ${new Date().toISOString()}] Sent ${confirmationData} for job ${jobId}`);

  // Handle client disconnect
  req.on("close", () => {
    debugSSE(`[server.js LINE 194]: ${new Date().toISOString()}] Client disconnected for job ${jobId}`);
    sseConnections.delete(jobId);
  });

  req.on("error", (error) => {
    sseConnections.delete(jobId);
  });
});



// List objects in a bucket (Admin only)
app.get("/buckets/:bucketName/objects", async (req, res) => {
  //debugMinio(`Request received for bucket: ${req.params.bucketName}, prefix: ${req.query.prefix}}`);
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
    debugMinio("[server.js LINE 311]: Error in GET /buckets/:bucketName/objects:", error.message);
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

      // Clean the folder path: remove leading/trailing slashes, then ensure it ends with /
      let cleanPath = folderPath.trim();
      cleanPath = cleanPath.replace(/^\/+/, ""); // Remove leading slashes
      cleanPath = cleanPath.replace(/\/+$/, ""); // Remove trailing slashes
      cleanPath = cleanPath.replace(/\/+/g, "/"); // Replace multiple slashes with single slash

      if (!cleanPath) {
        debugAlbum(`[server.js LINE 336]: ERROR: Invalid folder path after cleaning`);
        return res.status(400).json({
          success: false,
          error: "Invalid folder path",
        });
      }

      const normalizedPath = `${cleanPath}/`;
      debugAlbum(`[server.js LINE 344]: Final normalized path: "${normalizedPath}"`);

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
        debugAlbum(`[server.js LINE 359]: ERROR: Folder already exists (${existingObjects.length} objects found)`);
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

// POST /buckets/:bucketName/upload - Upload file(s) to a bucket
app.post(
  "/buckets/:bucketName/upload",
  authenticateToken,
  upload.array("files"),
  async (req, res) => {
    const startTime = Date.now();
    const jobId = uuidv4(); // Generate unique job ID for this upload

    try {
      const { bucketName } = req.params;
      const { folderPath = "" } = req.body;
      const files = req.files;

      debugUpload(`[server.js LINE 429]: Upload request received:`, {
        jobId,
        bucket: bucketName,
        folder: folderPath,
        filesCount: files ? files.length : 0,
        user: req.user?.username || "unknown",
        timestamp: new Date().toISOString(),
      });

      if (!files || files.length === 0) {
        debugUpload(`[server.js LINE 439]: Upload failed: No files provided`);
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
      debugUpload(`[server.js LINE 463]: Upload error occurred after ${errorTime}ms:`, {
        error: error.message,
        stack: error.stack,
      });

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
});

app.get("/buckets/:bucketName/count", async (req, res) => {
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
});


// DELETE /buckets/:bucketName/upload - Delete objects(s) from a bucket
app.delete("/buckets/:bucketName/objects", authenticateToken, async (req, res) => {
  const { bucketName } = req.params;
  const { objectName } = req.body; // Example: "TEST/01.avif"

  try {
    await minioClient.removeObject(bucketName, objectName);

    debugUpload(`[server.js LINE 524]: Deleted object:`, {
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
    debugUpload(`[server.js LINE 536]: Delete error:`, error);
    res.status(500).json({
      success: false,
      error: "Failed to delete object. " + error.message,
    });
  }
});

// GET /bucket-stats - Returns statistics for the bucket (file count, unique folder paths, total size, file types)
app.get('/stats', async (req, res) => {
  try {
    const bucketName = config.minio.MINIO_BUCKET_NAME;
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
});

// Start server with database initialization
async function startServer() {
  try {
    // Initialize database connection
    let connectionPool = await initializeDatabase();

    debugServer(`[server.js LINE 551]: Database initialized successfully`);
    // Start HTTP server
    app.listen(PORT, () => {
      //const authMode = process.env.AUTH_MODE ;
      //const k8sService = process.env.K8S_SERVICE_NAME || "photovault-api-service";
      //const k8sNamespace = process.env.K8S_NAMESPACE || "photovault";
      //const publicUrl = process.env.PUBLIC_API_URL || "https://vault-api.hbvu.su";
      //debugServer(`Starting PhotoVault ${new Date()}...`);
      //debugServer(`> PhotoVault API server running on port ${PORT}`);
      //debugServer(`> Health check (internal): http://${k8sService}.${k8sNamespace}.svc.cluster.local:${PORT}/health`);
      //debugServer(`Health check (public): ${publicUrl}/health`);
      //debugServer(`> Authentication: http://${k8sService}.${k8sNamespace}.svc.cluster.local:${PORT}/auth/status`);
      //debugServer(`> MinIO endpoint: ${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`);
      //debugServer(`Auth Mode: ${authMode}`);
    });
  } catch (error) {
    debugServer(`[server.js LINE 567]: Failed to start server:`, error.message);
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
        debugUpload(`[server.js LINE 590]: Processing file ${i + 1}: ${file.originalname} >> ${file.mimetype}`);

        // Process the individual file
        const result = await uploadService.processAndUploadFile(
          file,
          bucketName,
          folderPath
        );
        uploadResults.push(result);

        debugUpload(`[server.js LINE 600]: Successfully processed: ${file.originalname}`);
      } catch (error) {
        debugUpload(`[server.js LINE 602]: Error processing file ${file.originalname}: ${error.message}`);
        errors.push({
          filename: file.originalname,
          error: error.message,
        });
      }
    }

    const processingTime = Date.now() - startTime;
    debugUpload(`[server.js LINE 611]: Background processing completed in ${processingTime}ms - Success: ${uploadResults.length}, Errors: ${errors.length}`);

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
      debugUpload(`[server.js LINE 650]: Cleaning up SSE connections for job ${jobId}`);
      sseConnections.delete(jobId);
    }, 300000);
  } catch (error) {
    const errorTime = Date.now() - startTime;
    debugUpload(`[server.js LINE 655]: Background processing error after ${errorTime}ms:`, {
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
  debugServer(`[server.js LINE 676]: Shutting down server...`);
  if (config.auth.mode) {
    await database.close();
  }
  process.exit(0);
});

// Mount route modules with dependency injection
app.use("/auth", authRoutes);
app.use("/user", userRoutes);
app.use("/", healthRoutes(minioClient, countAlbums));
app.use("/", albumRoutes(minioClient));

async function initializeDatabase() {
  //const authMode = process.env.AUTH_MODE;

  //if (authMode === "database") {
  try {
    await database.initialize();
  } catch (error) {
    debugDB(`[server.js LINE 690]: Database initialization failed:`, error.message);
    //process.env.AUTH_MODE = "demo";
  }
  /*} else {
    debugAuth("Running in demo authentication mode");
  }*/
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
      resolve(albums);
    });

    objectsStream.on("error", (err) => {
      debugMinio(`[server.js LINE 718]: Error listing objects:`, err);
      reject(err);
    });
  });
}
// Start the server
startServer();