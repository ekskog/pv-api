// Redis Service - Handles Redis connection and basic operations
const { createClient } = require('redis');

class RedisService {
  constructor() {
    this.client = null;
    this.connected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 5;
  }

  /**
   * Initialize Redis connection
   */
  async connect() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = process.env.REDIS_PORT || 6379;
    const redisDb = process.env.REDIS_DB || 2;
    const redisUseTLS = process.env.REDIS_USE_TLS === 'true';

    //console.log(`[REDIS] Attempting to connect to Redis at ${redisHost}:${redisPort}, DB: ${redisDb}, TLS: ${redisUseTLS}`);

    try {
      const socketConfig = {
        host: redisHost,
        port: redisPort,
        connectTimeout: 10000, // 10 seconds
        lazyConnect: true
      };

      // Add TLS configuration if needed
      if (redisUseTLS) {
        socketConfig.tls = true;
        socketConfig.rejectUnauthorized = false; // For self-signed certificates
      }

      this.client = createClient({
        socket: socketConfig,
        database: redisDb
      });

      // Event listeners
      this.client.on('error', (err) => {
        console.error('[REDIS] Redis Client Error:', err.message);
        this.connected = false;
      });

      this.client.on('connect', () => {
        //console.log('[REDIS] Redis client connected');
      });

      this.client.on('ready', () => {
        //console.log('[REDIS] Redis client ready');
        this.connected = true;
        this.connectionAttempts = 0;
      });

      this.client.on('end', () => {
        //console.log('[REDIS] Redis client disconnected');
        this.connected = false;
      });

      // Connect to Redis
      await this.client.connect();
      
      // Test the connection
      await this.client.ping();
      //console.log('[REDIS] Redis connection established successfully');
      
      return true;
    } catch (error) {
      console.error('[REDIS] Failed to connect to Redis:', error.message);
      this.connected = false;
      this.connectionAttempts++;
      
      if (this.connectionAttempts < this.maxRetries) {
        //console.log(`[REDIS] Retrying connection in 5 seconds... (Attempt ${this.connectionAttempts}/${this.maxRetries})`);
        setTimeout(() => this.connect(), 5000);
      } else {
        console.error('[REDIS] Max connection attempts reached. Redis will be unavailable.');
      }
      
      return false;
    }
  }

  /**
   * Check if Redis is connected and ready
   */
  isConnected() {
    return this.connected && this.client && this.client.isReady;
  }

  /**
   * Get Redis connection status for health checks
   */
  async getConnectionStatus() {
    if (!this.isConnected()) {
      return {
        connected: false,
        status: 'disconnected',
        error: 'Redis client not connected'
      };
    }

    try {
      const pong = await this.client.ping();
      return {
        connected: true,
        status: 'ready',
        ping: pong,
        database: process.env.REDIS_DB || 2,
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379
      };
    } catch (error) {
      return {
        connected: false,
        status: 'error',
        error: error.message
      };
    }
  }

  /**
   * Graceful shutdown
   */
  async disconnect() {
    if (this.client) {
      //console.log('[REDIS] Closing Redis connection...');
      try {
        await this.client.quit();
        //console.log('[REDIS] Redis connection closed gracefully');
      } catch (error) {
        console.error('[REDIS] Error closing Redis connection:', error.message);
        // Force close if graceful close fails
        this.client.disconnect();
      }
    }
  }

  /**
   * Get the Redis client instance (for advanced operations)
   * Only use this if you know what you're doing
   */
  getClient() {
    if (!this.isConnected()) {
      throw new Error('Redis client is not connected');
    }
    return this.client;
  }
}

// Create singleton instance
const redisService = new RedisService();

module.exports = redisService;
