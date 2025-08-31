// Database configuration and connection setup
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const config = require('../config'); // defaults to ./config/index.js


// --- Slug helpers -----------------------------------------------------------
function slugify(input) {
  return String(input || '')
    .normalize('NFKD')                  // split accents
    .replace(/[\u0300-\u036f]/g, '')    // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')        // non-alnum -> hyphen
    .replace(/^-+|-+$/g, '')            // trim hyphens
    .slice(0, 80);
}

function makeSlugWithId(name, id) {
  // Convert to lowercase and replace dots with dashes
  const base = name.toLowerCase().replace(/\./g, '-');
  return base || String(id);
}

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

  // Check if database is up and running
  async isHealthy() {
    if (!this.isInitialized || !this.pool) {
      return false;
    }

    try {
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();
      return true;
    } catch (error) {
      console.error("Database health check failed:", error.message);
      return false;
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

  // ========================= ALBUM METHODS =========================

  // Create new album
  async createAlbum({ name, path, description = null }) {
    const connection = await this.pool.getConnection();
    try {
      // Check if album with this path already exists
      const [existing] = await connection.execute(
        "SELECT id FROM albums WHERE path = ?",
        [path]
      );

      if (existing.length > 0) {
        throw new Error("Album with this path already exists");
      }

      // Insert album without slug first to get the ID
      const [result] = await connection.execute(
        "INSERT INTO albums (name, path, description, counter) VALUES (?, ?, ?, ?)",
        [name, path, description, 0]
      );

      const albumId = result.insertId;

      // Generate slug using the ID and update the record
      const slug = makeSlugWithId(name, albumId);
      
      await connection.execute(
        "UPDATE albums SET slug = ? WHERE id = ?",
        [slug, albumId]
      );

      // Return the complete album data
      return {
        id: albumId,
        name,
        slug,
        path,
        description,
      };
    } finally {
      connection.release();
    }
  }

  // Get album by name
  async getAlbumByName(name) {
    const connection = await this.pool.getConnection();
    try {
      const [rows] = await connection.execute(
        "SELECT id, name, slug, path, description, created_at, updated_at FROM albums WHERE name = ?",
        [name]
      );

      return rows.length > 0 ? rows[0] : null;
    } finally {
      connection.release();
    }
  }

  // Get album by ID
  async getAlbumById(albumId) {
    const connection = await this.pool.getConnection();
    try {
      const [rows] = await connection.execute(
        "SELECT id, name, slug, path, description, created_at, updated_at FROM albums WHERE id = ?",
        [albumId]
      );

      return rows.length > 0 ? rows[0] : null;
    } finally {
      connection.release();
    }
  }

  // Get album by path
  async getAlbumByPath(path) {
    const connection = await this.pool.getConnection();
    try {
      const [rows] = await connection.execute(
        "SELECT id, name, slug, path, description, created_at, updated_at FROM albums WHERE path = ?",
        [path]
      );

      return rows.length > 0 ? rows[0] : null;
    } finally {
      connection.release();
    }
  }

  // Get all albums
  async getAllAlbums() {
    const connection = await this.pool.getConnection();
    try {
      const [rows] = await connection.execute(
        "SELECT name, slug, path, description, created_at, updated_at FROM albums ORDER BY created_at DESC"
      );
      console.log('Fetched albums:', rows);
      return rows;
    } finally {
      connection.release();
    }
  }

  // Update album
  async updateAlbum(albumId, { name, description }) {
    const connection = await this.pool.getConnection();
    try {
      // If name is being updated, we might want to update the slug too
      let updateQuery = "UPDATE albums SET updated_at = CURRENT_TIMESTAMP";
      let params = [];

      if (name !== undefined) {
        updateQuery += ", name = ?, slug = ?";
        const newSlug = makeSlugWithId(name, albumId);
        params.push(name, newSlug);
      }

      if (description !== undefined) {
        updateQuery += ", description = ?";
        params.push(description);
      }

      updateQuery += " WHERE id = ?";
      params.push(albumId);

      const [result] = await connection.execute(updateQuery, params);

      return result.affectedRows > 0;
    } finally {
      connection.release();
    }
  }

  // Delete album
  async deleteAlbum(albumId) {
    const connection = await this.pool.getConnection();
    try {
      const [result] = await connection.execute(
        "DELETE FROM albums WHERE id = ?",
        [albumId]
      );

      return result.affectedRows > 0;
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