// Authentication middleware and utilities
const jwt = require('jsonwebtoken')
const database = require('../config/database')

// JWT secret key - should be in environment variables
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h'

// Demo users for development mode
const demoUsers = {
  admin: {
    id: 1,
    username: 'admin',
    email: 'admin@demo.local',
    role: 'admin',
    isActive: true
  },
  user: {
    id: 2,
    username: 'user', 
    email: 'user@demo.local',
    role: 'user',
    isActive: true
  }
}

// Demo credentials
const demoCredentials = {
  admin: 'admin123',
  user: 'user123'
}

class AuthService {
  
  // Generate JWT token
  static generateToken(user) {
    const payload = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    }
    
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
  }

  // Verify JWT token
  static verifyToken(token) {
    try {
      return jwt.verify(token, JWT_SECRET)
    } catch (error) {
      return null
    }
  }

  // Authenticate user based on auth mode
  static async authenticateUser(username, password) {
    const authMode = process.env.AUTH_MODE || 'demo'
    console.log(`Authentication mode: ${authMode}`)
  
    
    if (authMode === 'demo') {
      return this.authenticateDemoUser(username, password)
    } else {
      return this.authenticateDatabaseUser(username, password)
    }
  }

  // Demo authentication
  static async authenticateDemoUser(username, password) {
    const user = demoUsers[username]
    const validPassword = demoCredentials[username]
    
    if (user && password === validPassword) {
      return user
    }
    
    return null
  }

  // Database authentication
  static async authenticateDatabaseUser(username, password) {
    try {
      return await database.authenticateUser(username, password)
    } catch (error) {
      console.error('Database authentication error:', error.message)
      return null
    }
  }

  // Get user by ID
  static async getUserById(userId) {
    const authMode = process.env.AUTH_MODE || 'demo'
    
    if (authMode === 'demo') {
      // Find demo user by ID
      const user = Object.values(demoUsers).find(u => u.id === parseInt(userId))
      return user || null
    } else {
      try {
        return await database.getUserById(userId)
      } catch (error) {
        console.error('Database getUserById error:', error.message)
        return null
      }
    }
  }
}

// JWT Authentication Middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1] // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Access token required'
    })
  }

  try {
    const decoded = AuthService.verifyToken(token)
    if (!decoded) {
      return res.status(403).json({
        success: false,
        error: 'Invalid or expired token'
      })
    }

    // Get full user data
    const user = await AuthService.getUserById(decoded.id)
    if (!user) {
      return res.status(403).json({
        success: false,
        error: 'User not found'
      })
    }

    req.user = user
    next()
  } catch (error) {
    console.error('Auth middleware error:', error.message)
    return res.status(403).json({
      success: false,
      error: 'Token verification failed'
    })
  }
}

// Role-based authorization middleware
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      })
    }

    const userRoles = Array.isArray(roles) ? roles : [roles]
    if (!userRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions'
      })
    }

    next()
  }
}

module.exports = {
  AuthService,
  authenticateToken,
  requireRole
}
