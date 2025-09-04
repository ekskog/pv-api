// force rebuild on 11/08 13:38
require("dotenv").config();
const config = require("./config"); // defaults to ./config/index.js

// Debug namespaces
const debug = require("debug");
const debugServer = debug("photovault:server");
const debugSSE = debug("photovault:server:sse");
const debugDB = debug("photovault:server:database");
const debugUpload = debug("photovault:upload");

const express = require("express");
const cors = require("cors");
const app = express();
const PORT = config.server.port;

// Middleware
app.use(cors(config.cors));
app.use(express.json({ limit: "2gb" })); // Increased for video uploads
app.use(express.urlencoded({ limit: "2gb", extended: true })); // Increased for video uploads

// Import and Initialize services
const { Client } = require("minio");
// MinIO Client Configuration
let minioClient;
try {
  minioClient = new Client({
    endPoint: config.minio.endpoint,
    port: parseInt(config.minio.port),
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });
} catch (err) {
  debugServer(
    `[server.js LINE 39]: MinIO client initialization error: ${err.message}`
  );
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

// Store active SSE connections by job ID
const sseConnections = new Map();

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
    debugSSE(`[server.js (72)] Event "${eventType}" sent to job ${jobId}`);

    if (eventType === "complete") {
      // Send final message
      connection.write(`data: ${JSON.stringify(eventData)}\n\n`);

      // End the stream
      connection.end();
      sseConnections.delete(jobId);
    }
  } catch (error) {
    debugSSE(`[server.js (83)] Error sending to job ${jobId}: ${error.message}`);
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
  try {
    const uploadResults = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        debugUpload(`[server.js (104)] Processing file ${i + 1}: ${file.originalname} >> ${file.mimetype}`);

        // Process the individual file
        const result = await uploadService.processAndUploadFile(
          file,
          bucketName,
          folderPath
        );
        uploadResults.push(result);

        debugUpload(`[server.js (114)] Successfully processed: ${file.originalname}`);
      } catch (error) {
        debugUpload(`[server.js (116)] Error processing file ${file.originalname}: ${error.message}`);
        errors.push({
          filename: file.originalname,
          error: error.message,
        });
      }
    }

    const processingTime = Date.now() - startTime;
    debugUpload(`[server.js (125)] Background processing completed in ${processingTime}ms - Success: ${uploadResults.length}, Errors: ${errors.length}`);

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
      debugSSE(`[server.js (164)] Cleaning up SSE connections for job ${jobId}`);
      sseConnections.delete(jobId);
    }, 300000);
  } catch (error) {
    const errorTime = Date.now() - startTime;
    debugUpload(`[server.js (169)] Background processing error after ${errorTime}ms:`,{error: error.message, stack: error.stack});

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

// SSE endpoint - for monitoring upload progress
app.get("/processing-status/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  debugSSE(`[server.js (206)] Client connecting for job ${jobId}`);

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Transfer-Encoding": "chunked",
    "Access-Control-Allow-Headers": "Cache-Control",
  });

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

  // Handle client disconnect
  req.on("close", () => {
    debugSSE(`[server.js (234)] Client disconnected for job ${jobId}`);
    sseConnections.delete(jobId);
  });

  req.on("error", (error) => {
    sseConnections.delete(jobId);
  });
});

// Start server with database initialization
async function startServer() {
  try {
    // Initialize database connection
    let connectionPool = await initializeDatabase();

    debugServer(`[server.js] Database initialized successfully`);
    // Start HTTP server
    app.listen(PORT, () => {
      const k8sService = config.kubernetes.serviceName;
      const k8sNamespace = config.kubernetes.namespace || "photovault";
      debugServer(`Starting PhotoVault ${new Date()}...`);
      debugServer(
        `> PhotoVault API server running on port ${config.server.port}`
      );
    });
  } catch (error) {
    debugServer(`[server.js] Failed to start server:`, error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  debugServer(`[server.js] Shutting down server...`);
  if (config.auth.mode) {
    await database.close();
  }
  process.exit(0);
});

// Mount route modules with dependency injection
app.use("/auth", authRoutes);
app.use("/user", userRoutes);
app.use("/", healthRoutes(minioClient));
app.use("/", albumRoutes(minioClient, processFilesInBackground)); // Pass processFilesInBackground
app.use("/", statRoutes(minioClient));

async function initializeDatabase() {
  try {
    await database.initialize();
  } catch (error) {
    debugDB(
      `[server.js] Database initialization failed:`,
      error.message
    );
  }
}

// Start the server
startServer();