// Database configuration and connection setup
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const config = require('../config'); // defaults to ./config/index.js


class Database {
  constructor() {
    this.pool = null;
    this.isInitialized = false;
  }

  // Initialize database connection pool
  async initialize() {
    if (this.isInitialized) return;

    try {
      this.pool = mysql.createPool(config.database);
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();

      this.isInitialized = true;

      // Check if users exist before initializing defaults
      const users = await this.getAllUsers();
      if (users.length === 0) {
        await this.initializeDefaultUsers();
      } else {
        console.log(`${users.length} users already exist.`);
      }

      return connection;
    } catch (error) {
      console.error("Failed to initialize database:", error.message);
      throw error;
    }
  }

  // Initialize default users with proper password hashing
  async initializeDefaultUsers() {
    try {
      const users = [
        {
          username: "admin",
          email: "admin@photovault.local",
          password: "admin123",
          role: "admin",
        },
        {
          username: "user",
          email: "user@photovault.local",
          password: "user123",
          role: "user",
        },
      ];

      for (const userData of users) {
        await this.createUserIfNotExists(userData);
      }
    } catch (error) {
      console.error(
        "Warning: Could not initialize default users:",
        error.message
      );
    }
  }

  // Create user if not exists
  async createUserIfNotExists({ username, email, password, role }) {
    const connection = await this.pool.getConnection();
    try {
      // Check if user exists
      const [existing] = await connection.execute(
        "SELECT id FROM users WHERE username = ? OR email = ?",
        [username, email]
      );

      if (existing.length > 0) {
        throw new Error("User already exists");
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Create user
      const [result] = await connection.execute(
        "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
        [username, email, passwordHash, role]
      );

      // Return user data with the new ID
      return {
        id: result.insertId,
        username,
        email,
        role,
      };
    } finally {
      connection.release();
    }
  }

  // Get database connection
  getConnection() {
    if (!this.isInitialized) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    return this.pool;
  }

  // User authentication methods
  async authenticateUser(username, password) {
    const connection = await this.pool.getConnection();
    try {
      const [rows] = await connection.execute(
        "SELECT id, username, email, password_hash, role, is_active FROM users WHERE username = ? AND is_active = TRUE",
        [username]
      );
      if (rows.length === 0) {
        return null; // User not found
      }

      const user = rows[0];
      const isValid = await bcrypt.compare(password, user.password_hash);

      if (!isValid) {
        return null; // Invalid password
      }

      // Update last login
      await connection.execute(
        "UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?",
        [user.id]
      );

      // Return user without password hash
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.is_active,
      };
    } finally {
      connection.release();
    }
  }

  // Get user by ID
  async getUserById(userId) {
    const connection = await this.pool.getConnection();
    try {
      const [rows] = await connection.execute(
        "SELECT id, username, email, role, is_active, created_at, last_login FROM users WHERE id = ? AND is_active = TRUE",
        [userId]
      );

      return rows.length > 0 ? rows[0] : null;
    } finally {
      connection.release();
    }
  }

  // Get all users
  async getAllUsers() {
    const connection = await this.pool.getConnection();
    if (!this.isInitialized) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    try {
      const [rows] = await connection.execute(
        "SELECT id, username, email, role, is_active, created_at, last_login FROM users"
      );
      return rows;
    } finally {
      connection.release();
    }
  }

  // Create new user
  async createUser({ username, email, password, role = "user" }) {
    const connection = await this.pool.getConnection();
    try {
      // Check if user already exists
      const [existing] = await connection.execute(
        "SELECT id FROM users WHERE username = ? OR email = ?",
        [username, email]
      );

      if (existing.length > 0) {
        throw new Error("User with this username or email already exists");
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Create user
      const [result] = await connection.execute(
        "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
        [username, email, passwordHash, role]
      );

      return result.insertId;
    } finally {
      connection.release();
    }
  }

  // Close database connection
  async close() {
    if (this.pool) {
      await this.pool.end();
      this.isInitialized = false;
    }
  }
}

// Create singleton instance
const database = new Database();

module.exports = database;
