-- PhotoVault Database Schema
-- Run this script to initialize the database

USE photovault;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin', 'user') DEFAULT 'user',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL,
    
    INDEX idx_username (username),
    INDEX idx_email (email),
    INDEX idx_role (role),
    INDEX idx_active (is_active)
);

-- Insert default admin user (password: admin123)
-- Hash generated with bcryptjs for 'admin123'
INSERT IGNORE INTO users (username, email, password_hash, role) VALUES 
('admin', 'admin@photovault.local', '$2a$10$YourHashHere', 'admin');

-- Insert default regular user (password: user123)  
-- Hash generated with bcryptjs for 'user123'
INSERT IGNORE INTO users (username, email, password_hash, role) VALUES 
('user', 'user@photovault.local', '$2a$10$YourHashHere', 'user');

-- You'll need to update the password hashes above with actual bcrypt hashes
-- or use the API to create users with proper password hashing
