// force rebuild on 11/08 13:38
require("dotenv").config();
const config = require('./config'); // defaults to ./config/index.js

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
const bucketRoutes = require("./routes/buckets");

const { authenticateToken, requireRole } = require("./middleware/authMW");

// Debug namespaces
const debugServer = debug("photovault:server");
const debugSSE = debug("photovault:sse");
const debugMinio = debug("photovault:minio");
const debugDB = debug("photovault:database");

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
  debugServer("[server.js - line 76: MinIO Client Configuration:", config.minio.endpoint);

  minioClient = new Client({
    endPoint: config.minio.endpoint,
    port: parseInt(config.minio.port),
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });
} catch (err) {
  debugServer("[server.js - line 86]: MinIO client initialization failed:", err.message);
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
app.use("/", healthRoutes(minioClient, countAlbums));
app.use("/", albumRoutes(minioClient));
app.use("/", bucketRoutes(minioClient));

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