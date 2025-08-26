// config/index.js
require('dotenv').config();

const config = {
  // Server Configuration
  server: {
    port: process.env.PORT || 3000,
    environment: process.env.NODE_ENV || 'development',
  },

  // CORS Configuration
  cors: {
    origins: [
      "https://photos.hbvu.su",
      "http://localhost:5173", // Development
      "http://localhost:3000", // Alternative dev port
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-auth-token"],
  },

  // MinIO Configuration
  minio: {
    endpoint: process.env.MINIO_ENDPOINT,
    port: parseInt(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
    bucketName: process.env.MINIO_BUCKET_NAME,
  },

  // Upload Configuration
  upload: {
    maxFileSize: 2 * 1024 * 1024 * 1024, // 2GB
    allowedMimeTypes: [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/avif',
      'video/mp4',
      'video/mov',
      'video/avi',
      'video/quicktime'
    ],
  },

  // AVIF Converter Configuration
  converter: {
    url: process.env.AVIF_CONVERTER_URL,
    timeout: parseInt(process.env.AVIF_CONVERTER_TIMEOUT, 10) || 30000,
  },

  // Authentication Configuration
  auth: {
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },

  // Database Configuration
  database: {
        host: process.env.DB_HOST || "mariadb.data.svc.cluster.local",
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || "root",
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || "photovault",
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        connectTimeout: 60000,
      },

  // SSE Configuration
  sse: {
    connectionTimeout: 300000, // 5 minutes
    cleanupInterval: 60000,    // 1 minute
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableDebug: process.env.NODE_ENV === 'development',
  },

  mapbox_token: process.env.MAPBOX_TOKEN,   // Kubernetes Configuration (if applicable)
  kubernetes: {
    serviceName: process.env.K8S_SERVICE_NAME || 'photovault-api-service',
    namespace: process.env.K8S_NAMESPACE || 'photovault',
    publicUrl: process.env.PUBLIC_API_URL || 'https://vault-api.hbvu.su',
  },
};

// Validation function to ensure required config is present
const validateConfig = () => {
  const required = [
    'minio.endpoint',
    'minio.accessKey',
    'minio.secretKey',
    'minio.bucketName',
  ];

  const missing = required.filter(key => {
    const value = key.split('.').reduce((obj, k) => obj?.[k], config);
    return !value;
  });

  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
};

module.exports = {
  ...config,
  validateConfig,
};