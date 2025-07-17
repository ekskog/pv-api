require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const morgan = require("morgan");
const { Client } = require("minio");
const { v4: uuidv4 } = require("uuid");

// Import authentication components
const database = require("./config/database");
const authRoutes = require("./routes/auth");
const { authenticateToken, requireRole } = require("./middleware/auth");

// Store active SSE connections by job ID
const sseConnections = new Map();

// Helper function to send SSE event
const sendSSEEvent = (jobId, eventType, data) => {
  const connections = sseConnections.get(jobId);
  if (!connections) return;

  const eventData = {
    type: eventType,
    timestamp: new Date().toISOString(),
    ...data,
  };

  const message = `data: ${JSON.stringify(eventData)}\n\n`;

  // Send to all connections for this job
  connections.forEach((res, connectionId) => {
    try {
      res.write(message);
    } catch (error) {
      console.error(
        `[SSE] Error sending to connection ${connectionId}:`,
        error.message
      );
      // Remove failed connection
      connections.delete(connectionId);
    }
  });

  // Clean up if no connections left
  if (connections.size === 0) {
    sseConnections.delete(jobId);
  }
};

// Import services
const UploadService = require("./services/upload-service");
const AvifConverterService = require("./services/avif-converter-service");
const MetadataService = require("./services/metadata-service");

const app = express();
const PORT = process.env.PORT;
// Add this line to store the server instance
let server;

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

// Add Morgan for HTTP request logging
app.use(
  morgan(
    ":method :url :status :response-time ms - :res[content-length] bytes",
    {
      stream: {
        write: (message) => {
          console.log(`[HTTP] ${message.trim()}`);
        },
      },
    }
  )
);

// SSE endpoint for processing status
app.get("/api/processing-status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const connectionId = uuidv4();

  console.log(
    `[SSE] New connection for job ${jobId}, connection ID: ${connectionId}`
  );

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",
  });

  // Send initial connection message
  res.write(
    `data: ${JSON.stringify({
      type: "connected",
      jobId: jobId,
      message: "Connected to processing status stream",
      timestamp: new Date().toISOString(),
    })}\n\n`
  );

  // Store this connection
  if (!sseConnections.has(jobId)) {
    sseConnections.set(jobId, new Map());
  }
  sseConnections.get(jobId).set(connectionId, res);

  // Handle client disconnect
  req.on("close", () => {
    console.log(`[SSE] Connection ${connectionId} closed for job ${jobId}`);
    const connections = sseConnections.get(jobId);
    if (connections) {
      connections.delete(connectionId);
      if (connections.size === 0) {
        sseConnections.delete(jobId);
      }
    }
  });

  // Keep connection alive with heartbeat
  const heartbeat = setInterval(() => {
    try {
      res.write(
        `data: ${JSON.stringify({
          type: "heartbeat",
          timestamp: new Date().toISOString(),
        })}\n\n`
      );
    } catch (error) {
      console.error(
        `[SSE] Heartbeat failed for connection ${connectionId}:`,
        error.message
      );
      clearInterval(heartbeat);
      const connections = sseConnections.get(jobId);
      if (connections) {
        connections.delete(connectionId);
        if (connections.size === 0) {
          sseConnections.delete(jobId);
        }
      }
    }
  }, 30000); // Send heartbeat every 30 seconds

  // Clean up heartbeat on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

// Initialize Services
const uploadService = new UploadService(minioClient);

// Health check route
app.get("/health", async (req, res) => {
  console.log(
    `[HEALTH] Health check request received from ${
      req.ip
    } at ${new Date().toISOString()}`
  );
  try {
    // Test MinIO connection by listing albums
    const albums = await countAlbums(process.env.MINIO_BUCKET_NAME);
    console.log(
      `[HEALTH] MinIO connection successful, found ${albums.length} albums`
    );

    // Check JPEG converter service
    let jpegConverterHealthy = false;
    try {
      // Get the converter URL from environment, with Kubernetes service URL as fallback
      const jpegConverterUrl = process.env.JPEG2AVIF_CONVERTER_URL;

      console.log(
        `[HEALTH] Testing JPEG converter connection at ${jpegConverterUrl}`
      );

      const jpegResponse = await fetch(`${jpegConverterUrl}/health`, {
        timeout: parseInt(process.env.JPEG2AVIF_CONVERTER_TIMEOUT),
      });

      if (jpegResponse.ok) {
        jpegConverterHealthy = true;
        console.log(`[HEALTH] JPEG converter is healthy`);
      } else {
        console.error(
          `[HEALTH] JPEG converter responded with status: ${jpegResponse.status}`
        );
      }
    } catch (error) {
      console.error(
        `[HEALTH] JPEG converter health check failed: ${error.message}`
      );
    }

    // Check HEIC converter service
    let heicConverterHealthy = false;
    try {
      // Get the converter URL from environment, with Kubernetes service URL as fallback
      const heicConverterUrl = process.env.HEIC2AVIF_CONVERTER_URL;

      console.log(
        `[HEALTH] Testing HEIC converter connection at ${heicConverterUrl}`
      );
      console.log(
        `[HEALTH] Using timeout: ${parseInt(
          process.env.HEIC2AVIF_CONVERTER_TIMEOUT
        )}ms`
      );

      const heicResponse = await fetch(`${heicConverterUrl}/health`, {
        timeout: parseInt(process.env.HEIC2AVIF_CONVERTER_TIMEOUT),
      });

      if (heicResponse.ok) {
        heicConverterHealthy = true;
        console.log(`[HEALTH] HEIC converter is healthy`);
      } else {
        console.error(
          `[HEALTH] HEIC converter responded with status: ${heicResponse.status}`
        );
      }
    } catch (error) {
      console.error(
        `[HEALTH] HEIC converter health check failed: ${error.message}`
      );
      console.error(
        `[HEALTH] Make sure the converter service is running and accessible via K8s service name`
      );
    }

    // Determine overall health status based on MinIO and BOTH converter services
    // All three must be healthy for the API to function properly
    const isHealthy =
      albums.length > 0 && jpegConverterHealthy && heicConverterHealthy;
    const status = isHealthy ? "healthy" : "degraded";

    const warnings = [];
    if (!jpegConverterHealthy) {
      warnings.push(
        "JPEG converter service is unavailable - image conversion will fail"
      );
    }
    if (!heicConverterHealthy) {
      warnings.push(
        "HEIC converter service is unavailable - HEIC image conversion will fail"
      );
    }

    const healthStatus = {
      status,
      timestamp: new Date().toISOString(),
      minio: {
        connected: true,
        albums: albums.length,
        endpoint: process.env.MINIO_ENDPOINT,
      },
      converters: {
        jpeg: {
          connected: jpegConverterHealthy,
          endpoint: process.env.JPEG2AVIF_CONVERTER_URL,
        },
        heic: {
          connected: heicConverterHealthy,
          endpoint: process.env.HEIC2AVIF_CONVERTER_URL,
        },
      },
    };

    if (warnings.length > 0) {
      healthStatus.warnings = warnings;
    }

    const responseStatus = isHealthy ? 200 : 503;
    console.log(
      `[HEALTH] Sending response with status: ${status}, code: ${responseStatus}`
    );
    res.status(responseStatus).json(healthStatus);
  } catch (error) {
    console.error(`[HEALTH] Error during health check: ${error.message}`);

    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      minio: {
        connected: false,
        error: error.message,
      },
      converters: {
        jpeg: {
          connected: false,
          endpoint: process.env.JPEG2AVIF_CONVERTER_URL,
          error: "Could not verify due to MinIO connection failure",
        },
        heic: {
          connected: false,
          endpoint: process.env.HEIC2AVIF_CONVERTER_URL,
          error: "Could not verify due to MinIO connection failure",
        },
      },
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

      console.log(`[FOLDER_CREATE] Extracted folderPath: "${folderPath}"`);

      if (!folderPath) {
        console.log(`[FOLDER_CREATE] ERROR: Folder path is required`);
        return res.status(400).json({
          success: false,
          error: "Folder path is required",
        });
      }

      // Check if bucket exists
      console.log(`[FOLDER_CREATE] Checking if bucket exists: ${bucketName}`);
      const bucketExists = await minioClient.bucketExists(bucketName);
      console.log(`[FOLDER_CREATE] Bucket exists: ${bucketExists}`);

      if (!bucketExists) {
        console.log(`[FOLDER_CREATE] ERROR: Bucket not found`);
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
        console.log(
          `[FOLDER_CREATE] ERROR: Invalid folder path after cleaning`
        );
        return res.status(400).json({
          success: false,
          error: "Invalid folder path",
        });
      }

      const normalizedPath = `${cleanPath}/`;
      console.log(`[FOLDER_CREATE] Final normalized path: "${normalizedPath}"`);

      // Check if folder already exists by looking for any objects with this prefix
      console.log(
        `[FOLDER_CREATE] Checking for existing objects with prefix: "${normalizedPath}"`
      );
      const existingObjects = [];
      const stream = minioClient.listObjectsV2(
        bucketName,
        normalizedPath,
        false
      );

      for await (const obj of stream) {
        console.log(`[FOLDER_CREATE] Found existing object: ${obj.name}`);
        existingObjects.push(obj);
        break; // We only need to check if any object exists with this prefix
      }

      if (existingObjects.length > 0) {
        console.log(
          `[FOLDER_CREATE] ERROR: Folder already exists (${existingObjects.length} objects found)`
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
          totalPhotos: 0,
          totalSize: 0,
          lastModified: new Date().toISOString(),
        },
        photos: [],
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

// Background processing function for asynchronous uploads with SSE updates
async function processFilesInBackground(
  files,
  bucketName,
  folderPath,
  startTime,
  jobId
) {
  try {
    console.log(
      `[UPLOAD_BG] Starting background processing for ${files.length} files with job ID: ${jobId}`
    );

    // Process files
    const uploadResults = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        console.log(
          `[UPLOAD_BG] Processing file ${i + 1}/${files.length}: ${
            file.originalname
          }`
        );

        // Process the individual file
        const result = await uploadService.processSingleFile(
          file,
          bucketName,
          folderPath
        );
        uploadResults.push(result);

        console.log(`[UPLOAD_BG] Successfully processed: ${file.originalname}`);
      } catch (error) {
        console.error(
          `[UPLOAD_BG] Error processing file ${file.originalname}:`,
          error.message
        );
        errors.push({
          filename: file.originalname,
          error: error.message,
        });
      }
    }

    const processingTime = Date.now() - startTime;
    console.log(
      `[UPLOAD_BG] Background processing completed in ${processingTime}ms - Success: ${uploadResults.length}, Errors: ${errors.length}`
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
      console.log(`[UPLOAD_BG] Cleaning up SSE connections for job ${jobId}`);
      sseConnections.delete(jobId);
    }, 300000);
  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error(
      `[UPLOAD_BG] Background processing error after ${errorTime}ms:`,
      {
        error: error.message,
        stack: error.stack,
      }
    );

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

      console.log(`[UPLOAD] Upload request received:`, {
        jobId,
        bucket: bucketName,
        folder: folderPath,
        filesCount: files ? files.length : 0,
        user: req.user?.username || "unknown",
        timestamp: new Date().toISOString(),
      });

      if (!files || files.length === 0) {
        console.error("[UPLOAD] Upload failed: No files provided");
        return res.status(400).json({
          success: false,
          error: "No files provided",
        });
      }

      console.log(
        "[UPLOAD] Files to upload:",
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

      console.log(`[UPLOAD] Returning immediate response to user:`, {
        statusCode: 200,
        filesReceived: files.length,
        jobId: jobId,
        totalTime: `${Date.now() - startTime}ms`,
      });

      res.status(200).json(response);

      // Now process files in background with SSE updates
      processFilesInBackground(files, bucketName, folderPath, startTime, jobId);
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

    console.log("[UPLOAD SERVICE] About to stream object:", {
      bucketName,
      object,
    });

    // Stream the object directly to the response
    const objectStream = await minioClient.getObject(bucketName, object);
    console.log("[UPLOAD SERVICE] Object stream created successfully");

    // Retrieve object metadata
    const objectStat = await minioClient.statObject(bucketName, object);

    console.log(
      "[UPLOAD SERVICE] Object metadata retrieved successfully:",
      objectStat
    );

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

    // Start HTTP server and store the reference
    server = app.listen(PORT, () => {
      const authMode = process.env.AUTH_MODE || "demo";
      const k8sService =
        process.env.K8S_SERVICE_NAME || "photovault-api-service";
      const k8sNamespace = process.env.K8S_NAMESPACE || "webapps";
      const publicUrl =
        process.env.PUBLIC_API_URL || "https://vault-api.hbvu.su";
      console.log(`\nStarting PhotoVault ${new Date()}...`);
      console.log(`PhotoVault API server running on port ${PORT}`);
      console.log(
        `Health check (internal): http://${k8sService}.${k8sNamespace}.svc.cluster.local:${PORT}/health`
      );
      console.log(`Health check (public): ${publicUrl}/health`);
      console.log(
        `Authentication: http://${k8sService}.${k8sNamespace}.svc.cluster.local:${PORT}/auth/status`
      );
      console.log(
        `MinIO endpoint: ${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`
      );
      console.log(`Auth Mode: ${authMode}`);

      if (authMode === "demo") {
        console.log("Demo users available: admin/admin123, user/user123");
      }
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  console.log("Shutting down server...");

  // Close all SSE connections - fixed for your actual data structure
  console.log(
    `[SHUTDOWN] Closing ${sseConnections.size} active SSE job streams...`
  );
  sseConnections.forEach((connections, jobId) => {
    connections.forEach((res, connectionId) => {
      try {
        res.write("event: shutdown\n");
        res.write("data: Server is shutting down\n\n");
        res.end();
      } catch (error) {
        console.error(
          `[SHUTDOWN] Error closing connection ${connectionId}:`,
          error.message
        );
      }
    });
  });

  // Clear the connections map
  sseConnections.clear();

  // Close the HTTP server
  if (server) {
    server.close(() => {
      console.log("[SHUTDOWN] HTTP server closed");
      process.exit(0);
    });
  } else {
    console.log("[SHUTDOWN] No server instance to close");
    process.exit(0);
  }

  // Force shutdown after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error("[SHUTDOWN] Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
});

// Handle SIGTERM as well (for production deployments)
process.on("SIGTERM", async () => {
  console.log("Received SIGTERM, shutting down gracefully...");

  // Close all SSE connections
  console.log(
    `[SHUTDOWN] Closing ${sseConnections.size} active SSE connections...`
  );
  sseConnections.forEach((connections, userId) => {
    connections.forEach((res) => {
      res.write("event: shutdown\n");
      res.write("data: Server is shutting down\n\n");
      res.end();
    });
  });

  // Clear the connections map
  sseConnections.clear();

  // Close the HTTP server
  server.close(() => {
    console.log("[SHUTDOWN] HTTP server closed");
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error("[SHUTDOWN] Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
});
