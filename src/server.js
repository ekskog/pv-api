// force rebuild on 11/08 13:38
require("dotenv").config();
const config = require('./config'); // defaults to ./config/index.js

// Debug namespaces
const debug = require("debug");
const debugServer = debug("photovault:server");
const debugSSE = debug("photovault:server:sse");
const debugDB = debug("photovault:server:database");

const express = require("express");
const cors = require("cors");
const app = express();
const PORT = config.server.port;
// Middleware
app.use(cors(config.cors));
app.use(express.json({ limit: "2gb" })); // Increased for video uploads
app.use(express.urlencoded({ limit: "2gb", extended: true })); // Increased for video uploads

const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { authenticateToken, requireRole } = require("./middleware/authMW");

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

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB limit for large video files from iPhone
  },
});

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

// Start server with database initialization
async function startServer() {
  try {
    // Initialize database connection
    let connectionPool = await initializeDatabase();

    debugServer(`[server.js LINE 551]: Database initialized successfully`);
    // Start HTTP server
    app.listen(PORT, () => {
      const k8sService = config.kubernetes.serviceName;
      const k8sNamespace = config.kubernetes.namespace || "photovault";
      debugServer(`Starting PhotoVault ${new Date()}...`);
      debugServer(`> PhotoVault API server running on port ${config.server.port}`);
    });
  } catch (error) {
    debugServer(`[server.js LINE 567]: Failed to start server:`, error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  debugServer(`[server.js LINE 220]: Shutting down server...`);
  if (config.auth.mode) {
    await database.close();
  }
  process.exit(0);
});

// Mount route modules with dependency injection
app.use("/auth", authRoutes);
app.use("/user", userRoutes);
app.use("/", healthRoutes(minioClient));
app.use("/", albumRoutes(minioClient));
app.use("/", statRoutes(minioClient));

async function initializeDatabase() {
  //const authMode = process.env.AUTH_MODE;

  //if (authMode === "database") {
  try {
    await database.initialize();
  } catch (error) {
    debugDB(`[server.js LINE 241]: Database initialization failed:`, error.message);
    //process.env.AUTH_MODE = "demo";
  }
  /*} else {
    debugAuth("Running in demo authentication mode");
  }*/
}

// Start the server
startServer();