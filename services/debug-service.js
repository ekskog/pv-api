// Debug Service - Centralized debug logging for HBVU PHOTOS API
// Uses the 'debug' npm package for structured, controllable logging
const debug = require('debug');

/**
 * Debug Service for HBVU PHOTOS API
 * 
 * Environment Variables:
 * - DEBUG: Controls which debug namespaces are enabled (e.g., "hbvu:*", "hbvu:upload:*")
 * - DEBUG_PATTERN: Alternative pattern for debug control (used in Kubernetes)
 * 
 * Usage:
 * const debugService = require('./services/debug-service');
 * const debug = debugService.upload.file;
 * debug('Processing file:', filename);
 */

// Create organized debug namespaces for different components
const createDebuggers = () => {
  return {
    // Server & Core
    server: {
      startup: debug('hbvu:server:startup'),
      request: debug('hbvu:server:request'),
      response: debug('hbvu:server:response'),
      error: debug('hbvu:server:error'),
      shutdown: debug('hbvu:server:shutdown')
    },

    // Authentication & Authorization
    auth: {
      login: debug('hbvu:auth:login'),
      token: debug('hbvu:auth:token'),
      middleware: debug('hbvu:auth:middleware'),
      validation: debug('hbvu:auth:validation'),
      error: debug('hbvu:auth:error')
    },

    // Database Operations
    database: {
      connection: debug('hbvu:database:connection'),
      query: debug('hbvu:database:query'),
      transaction: debug('hbvu:database:transaction'),
      migration: debug('hbvu:database:migration'),
      error: debug('hbvu:database:error')
    },

    // Upload Service
    upload: {
      file: debug('hbvu:upload:file'),
      processing: debug('hbvu:upload:processing'),
      conversion: debug('hbvu:upload:conversion'),
      minio: debug('hbvu:upload:minio'),
      progress: debug('hbvu:upload:progress'),
      error: debug('hbvu:upload:error')
    },

    // MinIO Storage Operations
    storage: {
      bucket: debug('hbvu:storage:bucket'),
      object: debug('hbvu:storage:object'),
      list: debug('hbvu:storage:list'),
      upload: debug('hbvu:storage:upload'),
      download: debug('hbvu:storage:download'),
      delete: debug('hbvu:storage:delete'),
      error: debug('hbvu:storage:error')
    },

    // Image Processing
    image: {
      metadata: debug('hbvu:image:metadata'),
      heic: debug('hbvu:image:heic'),
      avif: debug('hbvu:image:avif'),
      sharp: debug('hbvu:image:sharp'),
      conversion: debug('hbvu:image:conversion'),
      error: debug('hbvu:image:error')
    },

    // API Routes
    api: {
      buckets: debug('hbvu:api:buckets'),
      objects: debug('hbvu:api:objects'),
      folders: debug('hbvu:api:folders'),
      health: debug('hbvu:api:health'),
      error: debug('hbvu:api:error')
    },

    // Performance Monitoring
    performance: {
      timing: debug('hbvu:performance:timing'),
      memory: debug('hbvu:performance:memory'),
      cpu: debug('hbvu:performance:cpu'),
      size: debug('hbvu:performance:size')
    },

    // General & Utility
    general: debug('hbvu:general'),
    error: debug('hbvu:error'),
    warning: debug('hbvu:warning'),
    info: debug('hbvu:info')
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
 * Performance timing helper
 */
const createTimer = (namespace, operation) => {
  const startTime = process.hrtime.bigint();
  const debugFn = debuggers.performance.timing;
  
  debugFn(`Starting ${operation} in ${namespace}`);
  
  return {
    end: (details = {}) => {
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
      
      debugFn(`Completed ${operation} in ${namespace}: ${duration.toFixed(2)}ms`, details);
      return duration;
    }
  };
};

/**
 * Memory usage helper
 */
const logMemoryUsage = (operation) => {
  const usage = process.memoryUsage();
  debuggers.performance.memory(`Memory usage after ${operation}:`, {
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
  
  if (debugPattern) {
    process.env.DEBUG = debugPattern;
    debuggers.general(`Debug patterns initialized: ${debugPattern}`);
  } else {
    debuggers.general('No debug patterns set - use DEBUG or DEBUG_PATTERN environment variable');
  }
};

// Initialize debug patterns on module load
initializeDebugPatterns();

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
  
  // Quick access to commonly used debuggers
  log: debuggers.general,
  error: debuggers.error,
  warn: debuggers.warning,
  info: debuggers.info
};
