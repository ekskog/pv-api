// Authentication routes - Updated login route only
// 2025-09-02T06:22:37.258Z - Integrate Cloudfare Turnstyle
const express = require('express')
const { AuthService, authenticateToken, requireRole } = require('../middleware/authMW')
const router = express.Router()
const database = require('../services/database-service');
const debug = require("debug");
const debugAuth = debug("photovault:auth");
// debugAuth('Auth middleware initialized');
const config = require('../config'); // defaults to ./config/index.js

// Function to verify Turnstile token with Cloudflare
async function verifyTurnstileToken(token, remoteip) {
  const formData = new URLSearchParams()
  formData.append('secret', process.env.TURNSTILE_SECRET_KEY)
  formData.append('response', token)
  formData.append('remoteip', remoteip)

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })

    const data = await response.json()
    debugAuth(`[auth.js]: Turnstile verification result: ${JSON.stringify(data)}`)
    
    return data.success === true
  } catch (error) {
    // debugAuth(`[auth.js]: Turnstile verification error: ${error.message}`)
    return false
  }
}

// POST /auth/login - User login (UPDATED with Turnstile)
router.post('/login', async (req, res) => {
  // debugAuth(`[auth.js - line 14]: Login request received: ${JSON.stringify(req.body)}`);
  try {
    const { username, password, turnstileToken } = req.body // Added turnstileToken

    // Validate input
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username and password are required'
      })
    }

    // Verify Turnstile token
    if (!turnstileToken) {
      return res.status(400).json({
        success: false,
        error: 'Security verification is required'
      })
    }

    // Get client IP address
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || 
                     req.headers['x-real-ip'] ||
                     req.connection.remoteAddress || 
                     req.socket.remoteAddress ||
                     (req.connection.socket ? req.connection.socket.remoteAddress : null)

    // Verify the Turnstile token
    const isValidTurnstile = await verifyTurnstileToken(turnstileToken, clientIP)
    
    if (!isValidTurnstile) {
      debugAuth(`[auth.js]: Turnstile verification failed for IP: ${clientIP}`)
      return res.status(400).json({
        success: false,
        error: 'Security verification failed. Please try again.'
      })
    }

    // debugAuth(`[auth.js]: Turnstile verification passed for user: ${username}`)

    // Authenticate user (your existing logic)
    const user = await AuthService.authenticateUser(username, password)

    if (!user) {
      debugAuth(`[auth.js]: Authentication failed for user: ${username}`)
      return res.status(401).json({
        success: false,
        error: 'Invalid username or password'
      })
    }

    // Generate JWT token (your existing logic)
    const token = AuthService.generateToken(user)

    // Return success response (your existing response format)
    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role
        },
        token,
        expiresIn: config.auth.jwtExpiresIn || '24h'
      }
    })

  } catch (error) {
    console.error('Login error:', error.message)
    res.status(500).json({
      success: false,
      error: 'Internal server error during login'
    })
  }
})

// ... rest of your existing routes remain unchanged ...

module.exports = router;