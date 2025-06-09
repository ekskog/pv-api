// Debug Service - Centralized debug logging for HBVU PHOTOS API
// Environment-aware logging: Console (development) vs File (production/Kubernetes)
const debug = require('debug');
const fs = require('fs').promises;
const path = require('path');

/**
 * Debug Service for HBVU PHOTOS API
 * 
 * Environment Variables:
 * - NODE_ENV: Controls logging strategy ('production' = file logging only, others = console)
 * - DEBUG: Controls which debug namespaces are enabled (e.g., "hbvu:*", "hbvu:upload:*")
 * - DEBUG_PATTERN: Alternative pattern for debug control (used in Kubernetes)
 * - LOG_DIR: Directory for log files (default: './logs')
 * - SILENT_MODE: If set to 'true', completely disables all console output (for Kubernetes)
 * 
 * Strategy:
 * - Development: Console logging only
 * - Production/Kubernetes: File logging only (absolutely no console output)
 * - Silent Mode: No console output whatsoever (overrides all console logging)
 */

// Environment configuration
const isProduction = process.env.NODE_ENV === 'production';
const isSilentMode = process.env.SILENT_MODE === 'true';
const logDir = process.env.LOG_DIR || './logs';
const enableFileLogging = isProduction;
const enableConsoleLogging = !isProduction && !isSilentMode;

// Ensure log directory exists in production
const initializeLogDirectory = async () => {
  if (enableFileLogging) {
    try {
      await fs.mkdir(logDir, { recursive: true });
      // Only log to console in development and non-silent mode
      if (enableConsoleLogging) {
        console.log(`📁 Log directory initialized: ${logDir}`);
      }
    } catch (error) {
      // Critical error - only log in development or use stderr in production
      if (enableConsoleLogging) {
        console.error('❌ Failed to create log directory:', error);
      } else if (isProduction && process.stderr && !isSilentMode) {
        process.stderr.write(`Failed to create log directory: ${error.message}\n`);
      }
    }
  }
};

// Initialize log directory
initializeLogDirectory();

/**
 * Enhanced logging function that supports both console and file output
 */
const createEnhancedLogger = (namespace) => {
  const consoleDebugger = debug(namespace);
  
  return async (message, data = {}) => {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      namespace,
      message,
      data,
      pid: process.pid,
      memory: enableFileLogging ? process.memoryUsage() : undefined
    };

    // Console logging (development)
    if (enableConsoleLogging) {
      consoleDebugger(message, data);
    }

    // File logging (production)
    if (enableFileLogging) {
      try {
        const category = namespace.split(':')[1] || 'general';
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(logDir, `${category}-${today}.log`);
        
        await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n');
      } catch (error) {
        // In production/silent mode, avoid any console output
        // Only use stderr for critical failures if not in silent mode
        if (isProduction && process.stderr && !isSilentMode) {
          process.stderr.write(`File logging failed: ${error.message}\n`);
        } else if (enableConsoleLogging) {
          // Fallback to console only in development
          console.error('❌ File logging failed:', error);
          console.log('📝 Log entry:', logEntry);
        }
      }
    }
  };
};

// Create organized debug namespaces for different components
const createDebuggers = () => {
  return {
    // Server & Core
    server: {
      startup: createEnhancedLogger('hbvu:server:startup'),
      request: createEnhancedLogger('hbvu:server:request'),
      response: createEnhancedLogger('hbvu:server:response'),
      error: createEnhancedLogger('hbvu:server:error'),
      shutdown: createEnhancedLogger('hbvu:server:shutdown')
    },

    // Authentication & Authorization
    auth: {
      login: createEnhancedLogger('hbvu:auth:login'),
      token: createEnhancedLogger('hbvu:auth:token'),
      middleware: createEnhancedLogger('hbvu:auth:middleware'),
      validation: createEnhancedLogger('hbvu:auth:validation'),
      error: createEnhancedLogger('hbvu:auth:error')
    },

    // Database Operations
    database: {
      connection: createEnhancedLogger('hbvu:database:connection'),
      query: createEnhancedLogger('hbvu:database:query'),
      transaction: createEnhancedLogger('hbvu:database:transaction'),
      migration: createEnhancedLogger('hbvu:database:migration'),
      error: createEnhancedLogger('hbvu:database:error')
    },

    // Upload Service
    upload: {
      file: createEnhancedLogger('hbvu:upload:file'),
      processing: createEnhancedLogger('hbvu:upload:processing'),
      conversion: createEnhancedLogger('hbvu:upload:conversion'),
      minio: createEnhancedLogger('hbvu:upload:minio'),
      progress: createEnhancedLogger('hbvu:upload:progress'),
      error: createEnhancedLogger('hbvu:upload:error')
    },

    // MinIO Storage Operations
    storage: {
      bucket: createEnhancedLogger('hbvu:storage:bucket'),
      object: createEnhancedLogger('hbvu:storage:object'),
      list: createEnhancedLogger('hbvu:storage:list'),
      upload: createEnhancedLogger('hbvu:storage:upload'),
      download: createEnhancedLogger('hbvu:storage:download'),
      delete: createEnhancedLogger('hbvu:storage:delete'),
      error: createEnhancedLogger('hbvu:storage:error')
    },

    // Image Processing
    image: {
      metadata: createEnhancedLogger('hbvu:image:metadata'),
      heic: createEnhancedLogger('hbvu:image:heic'),
      avif: createEnhancedLogger('hbvu:image:avif'),
      sharp: createEnhancedLogger('hbvu:image:sharp'),
      conversion: createEnhancedLogger('hbvu:image:conversion'),
      error: createEnhancedLogger('hbvu:image:error')
    },

    // API Routes
    api: {
      buckets: createEnhancedLogger('hbvu:api:buckets'),
      objects: createEnhancedLogger('hbvu:api:objects'),
      folders: createEnhancedLogger('hbvu:api:folders'),
      health: createEnhancedLogger('hbvu:api:health'),
      error: createEnhancedLogger('hbvu:api:error')
    },

    // Performance Monitoring
    performance: {
      timing: createEnhancedLogger('hbvu:performance:timing'),
      memory: createEnhancedLogger('hbvu:performance:memory'),
      cpu: createEnhancedLogger('hbvu:performance:cpu'),
      size: createEnhancedLogger('hbvu:performance:size')
    },

    // General & Utility
    general: createEnhancedLogger('hbvu:general'),
    error: createEnhancedLogger('hbvu:error'),
    warning: createEnhancedLogger('hbvu:warning'),
    info: createEnhancedLogger('hbvu:info')
  };
};

// Initialize debuggers
const debuggers = createDebuggers();

/**
 * Helper function to create consistent debug messages
 */
const formatMessage = (component, action, details = {}) => {
  const timestamp = new Date().toISOString();
  const baseMsg = `[${timestamp}] ${component.toUpperCase()}: ${action}`;
  
  if (Object.keys(details).length > 0) {
    return `${baseMsg} - ${JSON.stringify(details)}`;
  }
  return baseMsg;
};

/**
 * Performance timing helper with enhanced logging
 */
const createTimer = (namespace, operation) => {
  const startTime = process.hrtime.bigint();
  const debugFn = debuggers.performance.timing;
  
  // Start timing immediately (sync)
  debugFn(`Starting ${operation} in ${namespace}`);
  
  return {
    end: async (details = {}) => {
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
      
      await debugFn(`Completed ${operation} in ${namespace}: ${duration.toFixed(2)}ms`, {
        duration: `${duration.toFixed(2)}ms`,
        ...details
      });
      return duration;
    }
  };
};

/**
 * Memory usage helper with enhanced logging
 */
const logMemoryUsage = async (operation) => {
  const usage = process.memoryUsage();
  await debuggers.performance.memory(`Memory usage after ${operation}`, {
    rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
    external: `${Math.round(usage.external / 1024 / 1024)}MB`
  });
};

/**
 * File size helper
 */
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * Initialize debug patterns from environment variables
 * Supports both DEBUG and DEBUG_PATTERN environment variables
 */
const initializeDebugPatterns = () => {
  const debugPattern = process.env.DEBUG_PATTERN || process.env.DEBUG;
  
  if (debugPattern && enableConsoleLogging) {
    process.env.DEBUG = debugPattern;
    console.log(`🐛 Debug patterns initialized for console logging: ${debugPattern}`);
  } else if (enableFileLogging && enableConsoleLogging) {
    console.log(`📁 File logging enabled in production mode. Logs will be written to: ${logDir}`);
  } else if (enableConsoleLogging) {
    console.log('ℹ️  No debug patterns set - use DEBUG or DEBUG_PATTERN environment variable');
  }
  // In production or silent mode, remain completely silent
};

/**
 * Log rotation helper - clean up old log files
 */
const rotateLogFiles = async (maxAgeDays = 30) => {
  if (!enableFileLogging) return;
  
  try {
    const files = await fs.readdir(logDir);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
    
    for (const file of files) {
      if (file.endsWith('.log')) {
        const filePath = path.join(logDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime < cutoffDate) {
          await fs.unlink(filePath);
          // Only log rotation messages in development
          if (enableConsoleLogging) {
            console.log(`🗑️  Rotated old log file: ${file}`);
          }
        }
      }
    }
  } catch (error) {
    // Only log rotation errors in development
    if (enableConsoleLogging) {
      console.error('❌ Log rotation failed:', error);
    }
  }
};

// Initialize debug patterns on module load
initializeDebugPatterns();

// Set up log rotation (run daily in production)
if (enableFileLogging) {
  setInterval(rotateLogFiles, 24 * 60 * 60 * 1000); // Daily rotation
}

// Export the debug service
module.exports = {
  // Main debugger namespaces
  ...debuggers,
  
  // Utility functions
  formatMessage,
  createTimer,
  logMemoryUsage,
  formatFileSize,
  initializeDebugPatterns,
  rotateLogFiles,
  
  // Environment info
  isProduction,
  isSilentMode,
  enableFileLogging,
  enableConsoleLogging,
  logDir,
  
  // Quick access to commonly used debuggers
  log: debuggers.general,
  error: debuggers.error,
  warn: debuggers.warning,
  info: debuggers.info
};
