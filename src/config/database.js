// Database configuration and connection setup
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");

class Database {
  constructor() {
    this.pool = null;
    this.isInitialized = false;
  }

  // Initialize database connection pool
  async initialize() {
    console.log("Initializing database connection...");
    if (this.isInitialized) return;

    try {
      // Database connection configuration
      const dbConfig = {
        host: process.env.DB_HOST || "mariadb.data.svc.cluster.local",
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || "root",
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || "photovault",
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        connectTimeout: 60000, // Use this instead of acquireTimeout
      };

      console.log("Initializing database connection pool...");
      console.log(
        `Connecting to: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`
      );

      this.pool = mysql.createPool(dbConfig);
      console.log("Database connection pool created");

      // Test connection
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();

      console.log("Database connection pool initialized successfully");
      this.isInitialized = true;

      // Initialize default users if they don't exist
      await this.initializeDefaultUsers();

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
    
    console.log(`Created user: ${username} (${role})`);
    
    // Return user data with the new ID
    return { 
      id: result.insertId,
      username, 
      email,
      role 
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

    console.log("Authenticating user:", username);
    const connection = await this.pool.getConnection();
    try {
      const [rows] = await connection.execute(
        "SELECT id, username, email, password_hash, role, is_active FROM users WHERE username = ? AND is_active = TRUE",
        [username]
      );
      console.log(rows);
      if (rows.length === 0) {
        return null; // User not found
      }

      const user = rows[0];
      const isValid = await bcrypt.compare(password, user.password_hash);

      console.log(`Password valid: ${isValid}`);

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
      console.log("Database connection pool closed");
    }
  }
}

// Create singleton instance
const database = new Database();

module.exports = database;
