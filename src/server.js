// force rebuild on 18/10 19:36
require("dotenv").config();
const config = require("./config"); // defaults to ./config/index.js

// Debug namespaces
const debug = require("debug");
const debugServer = debug("photovault:server");
const debugSSE = debug("photovault:server:sse");
const debugDB = debug("photovault:server:database");
const debugUpload = debug("photovault:server:upload");

// temporal integration
const { Connection, Client: TemporalClient } = require("@temporalio/client");

const express = require("express");
const cors = require("cors");
const app = express();
const PORT = config.server.port;

// Middleware - Log all incoming requests BEFORE CORS
app.use((req, res, next) => {
  /*
  debugServer('🔍 Incoming request from origin:', req.headers.origin);
  debugServer('🔍 Request method:', req.method);
  debugServer('🔍 Request path:', req.path);
  */
  next();
});

// Middleware
app.use(cors(config.cors));

// Log successful CORS checks
app.use((req, res, next) => {
  // console.log('✅ Request passed CORS check');
  next();
});

app.use(express.json({ limit: "2gb" })); // Increased for video uploads
app.use(express.urlencoded({ limit: "2gb", extended: true })); // Increased for video uploads

// Import and Initialize services and dependencies

// Temporal Client Configuration
let temporalClient;

async function initTemporal() {
  try {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS || 'localhost:7233', // Adjust to your cluster address
    });
    temporalClient = new TemporalClient({
      connection,
      namespace: 'default',
    });
    debugServer("✓ Temporal Client initialized");
  } catch (err) {
    debugServer(`Temporal initialization error: ${err.message}`);
    temporalClient = null;
  }
}

// Minio Client Configuration

const { Client: MinioClient } = require("minio");
// MinIO Client Configuration
let minioClient;
try {
  minioClient = new MinioClient({
    endPoint: config.minio.endpoint,
    port: parseInt(config.minio.port),
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });
} catch (err) {
  debugServer(`[server.js LINE 39]: MinIO client initialization error: ${err.message}`);
  minioClient = null;
}
const UploadService = require("./services/upload-service");
const uploadService = new UploadService(minioClient);

// Import authentication components
const database = require("./services/database-service");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const healthRoutes = require("./routes/health");
const albumRoutes = require("./routes/albums");
const statRoutes = require("./routes/stats");
const temporalRoutes = require("./routes/temporalUploads"); // Added this for the new Temporal route

// Store active SSE connections and pending jobs by job ID
const sseConnections = new Map();
const pendingJobs = new Map();

const sendSSEEvent = (jobId, eventType, data = {}) => {
  const connection = sseConnections.get(jobId);
  if (!connection) {
    debugSSE(`[server.js (58)] No connection found for job ${jobId}`);
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
    // Force a flush by writing an empty chunk
    connection.write('');
    debugSSE(`[server.js (72)] Event "${eventType}" sent to job ${jobId}`);

    if (eventType === "complete") {
      // Send final message and end the stream
      connection.end();
      sseConnections.delete(jobId);
    }
  } catch (error) {
    debugSSE(`[server.js (97)] Error sending to job ${jobId}: ${error.message}`);
    sseConnections.delete(jobId);
  }
};

// Background processing function for asynchronous uploads with SSE updates
async function processFilesInBackground(
  files,
  bucketName,
  folderPath,
  startTime,
  jobId
) {
  debugUpload(`[server.js (110)] Starting background processing for job ${jobId} with ${files.length} files`);

  try {
    const uploadResults = [];
    const errors = [];
    const totalFiles = files.length;

    // Send initial starting event
    sendSSEEvent(jobId, "started", {
      status: "started",
      message: `Starting to process ${totalFiles} files...`,
      progress: {
        current: 0,
        total: totalFiles,
        percentage: 0,
        uploaded: 0,
        failed: 0,
      },
    });

    for (let i = 0; i < totalFiles; i++) {
      const file = files[i];
      debugUpload(`[server.js (132)] Processing file ${i + 1}/${totalFiles}: ${file.originalname}`);

      try {
        // Process the individual file
        const result = await uploadService.processAndUploadFile(
          file,
          bucketName,
          folderPath
        );
        uploadResults.push(result);
        debugUpload(`[server.js (142)] Successfully processed: ${file.originalname}`);

        // Send progress update after each successful file upload
        const progressPercent = Math.round(((i + 1) / totalFiles) * 100);
        sendSSEEvent(jobId, "progress", {
          status: "processing",
          message: `Successfully processed ${file.originalname}`,
          progress: {
            current: i + 1,
            total: totalFiles,
            percentage: progressPercent,
            lastUploaded: file.originalname,
            uploaded: uploadResults.length,
            failed: errors.length,
          },
        });

      } catch (error) {
        debugUpload(`[server.js (160)] Error processing file ${file.originalname}: ${error.message}`);
        errors.push({
          filename: file.originalname,
          error: error.message,
        });

        // Send progress update even for failed files
        const progressPercent = Math.round(((i + 1) / totalFiles) * 100);
        sendSSEEvent(jobId, "progress", {
          status: "processing",
          message: `Failed to process ${file.originalname}: ${error.message}`,
          progress: {
            current: i + 1,
            total: totalFiles,
            percentage: progressPercent,
            lastFailed: file.originalname,
            uploaded: uploadResults.length,
            failed: errors.length,
          },
        });
      }

      // Small delay to ensure event ordering and prevent overwhelming the client
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const processingTime = Date.now() - startTime;
    debugUpload(`[server.js (148)] Processing completed in ${processingTime}ms. Success: ${uploadResults.length}, Failed: ${errors.length}`);

    // Update database
    try {
      await database.incrementFileCounter(uploadResults.length, folderPath);
      debugUpload(`[server.js (152)] Updated file counter for ${folderPath} by ${uploadResults.length}`);
    } catch (dbError) {
      debugUpload(`[server.js (154)] Error updating file counter: ${dbError.message}`);
    }

    // Determine final status and send completion event
    let finalStatus, finalMessage;
    if (errors.length === 0) {
      finalStatus = "success";
      finalMessage = `All ${totalFiles} files processed successfully!`;
    } else if (uploadResults.length === 0) {
      finalStatus = "failed";
      finalMessage = `All ${totalFiles} files failed to process. Please check the files and try again.`;
    } else {
      finalStatus = "partial";
      finalMessage = `${uploadResults.length} files processed successfully, ${errors.length} failed.`;
    }

    sendSSEEvent(jobId, "complete", {
      status: finalStatus,
      message: finalMessage,
      results: {
        uploaded: uploadResults.length,
        failed: errors.length,
        processingTime: processingTime,
        total: totalFiles,
      },
      errors: errors.length > 0 ? errors : undefined,
    });

    debugUpload(`[server.js (173)] Sent completion event for job ${jobId}, status: ${finalStatus}`);

    // Schedule connection cleanup - give client time to receive the completion event
    setTimeout(() => {
      debugSSE(`[server.js (177)] Cleaning up SSE connections for job ${jobId}`);
      sseConnections.delete(jobId);
    }, 10000); // Reduced from 5 minutes to 10 seconds since job is complete

  } catch (error) {
    const errorTime = Date.now() - startTime;
    debugUpload(`[server.js (182)] Background processing failed after ${errorTime}ms:`, error.message);

    // Send error completion message
    sendSSEEvent(jobId, "complete", {
      status: "error",
      message: `Processing failed: ${error.message}`,
      error: error.message,
      results: {
        uploaded: 0,
        failed: 0,
        processingTime: errorTime,
        total: files.length,
      },
    });

    // Clean up connections after error
    setTimeout(() => {
      debugSSE(`[server.js (196)] Cleaning up SSE connections after error for job ${jobId}`);
      sseConnections.delete(jobId);
    }, 5000);
  }
}

// SSE endpoint - for monitoring upload progress
app.get("/processing-status/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  debugSSE(`[server.js (206)] Client connecting for job ${jobId}`);

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",
    "X-Accel-Buffering": "no", // Disable nginx buffering if present
  });

  // Disable Nagle's algorithm to reduce buffering
  if (res.socket) {
    res.socket.setNoDelay(true);
  }

  // Flush headers immediately
  res.flushHeaders();

  // Store connection
  sseConnections.set(jobId, res);
  debugSSE(`[server.js (220)] Connection stored for job ${jobId}. Total connections: ${sseConnections.size}`);

  // Send initial connection confirmation
  const confirmationData = JSON.stringify({
    type: "connected",
    jobId,
    message: "SSE connection established",
  });

  res.write(`data: ${confirmationData}\n\n`);
  debugSSE(`[server.js (230)] Sent ${confirmationData} for job ${jobId}`);

  // Check if there's a pending job and start it
  const pendingJob = pendingJobs.get(jobId);
  if (pendingJob) {
    debugSSE(`[server.js (234)] Found pending job ${jobId}, starting processing...`);
    pendingJobs.delete(jobId);

    // Start the background processing now that we have the SSE connection
    const { files, bucketName, folderPath } = pendingJob;
    const startTime = Date.now();

    processFilesInBackground(files, bucketName, folderPath, startTime, jobId).catch((error) => {
      debugSSE(`[server.js (241)] Error starting background processing for job ${jobId}:`, error.message);
    });
  } else {
    debugSSE(`[server.js (244)] No pending job found for ${jobId} (already processed or invalid job)`);
  }

  // Handle client disconnect
  req.on("close", () => {
    debugSSE(`[server.js (248)] Client disconnected for job ${jobId}`);
    sseConnections.delete(jobId);
  });

  req.on("error", (error) => {
    debugSSE(`[server.js (252)] SSE connection error for job ${jobId}:`, error.message);
    sseConnections.delete(jobId);
  });
});

// Start server with database initialization
async function startServer() {
  try {
    // Initialize database connection
    let connectionPool = await initializeDatabase();
    await initTemporal();

    //debugServer(`[server.js] Database initialized successfully`);
    // Start HTTP server
    app.listen(PORT, () => {
      const k8sService = config.kubernetes.serviceName;
      const k8sNamespace = config.kubernetes.namespace || "photovault";
      debugServer(`Starting PhotoVault ${new Date()}...`);
      debugServer(        `> PhotoVault API server running on port ${config.server.port}`      );
      
    });
  } catch (error) {
    //debugServer(`[server.js] Failed to start server:`, error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  //debugServer(`[server.js] Shutting down server...`);
  if (config.auth.mode) {
    await database.close();
  }
  process.exit(0);
});

// Mount route modules with dependency injection
app.use("/auth", authRoutes);
app.use("/user", userRoutes);
// In server.js
app.use("/", healthRoutes(minioClient, temporalClient));
app.use("/", albumRoutes(minioClient, { pendingJobs, processFilesInBackground })); // Pass processFilesInBackground and pendingJobs
app.use("/", statRoutes(minioClient));
// New Temporal Route for Bulk Uploads
const temporalRoutes = require("./routes/temporalUploads");
app.use("/bulk", temporalRoutes(temporalClient, config));

async function initializeDatabase() {
  try {
    await database.initialize();
  } catch (error) {
    debugDB(`[(262)] Database initialization failed:`, error.message);  
  }
}

// Start the server
startServer();