
// Authentication routes
const express = require('express')
const { AuthService, authenticateToken, requireRole } = require('../middleware/authMW')
const router = express.Router()

const database = require('../config/database');

// POST /auth/login - User login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body
    console.log("Logging in user:", username)

    // Validate input
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username and password are required'
      })
    }

    // Authenticate user
    const user = await AuthService.authenticateUser(username, password)
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid username or password'
      })
    }

    // Generate JWT token
    const token = AuthService.generateToken(user)

    // Return success response
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
        expiresIn: process.env.JWT_EXPIRES_IN || '24h'
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

// GET /auth/me - Get current user info
router.get('/me', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        user: {
          id: req.user.id,
          username: req.user.username,
          email: req.user.email,
          role: req.user.role,
          isActive: req.user.isActive
        }
      }
    })
  } catch (error) {
    console.error('Get user info error:', error.message)
    res.status(500).json({
      success: false,
      error: 'Failed to get user information'
    })
  }
})

// POST /auth/logout - User logout (client-side token removal)
router.post('/logout', authenticateToken, (req, res) => {
  // With JWT, logout is handled client-side by removing the token
  // Server-side logout would require token blacklisting (not implemented)
  res.json({
    success: true,
    message: 'Logout successful. Please remove the token from client storage.'
  })
})

// GET /auth/status - Check authentication status and mode
router.get('/status', (req, res) => {
  const authMode = process.env.AUTH_MODE || 'demo'
  
  res.json({
    success: true,
    data: {
      authMode,
      jwtConfigured: !!process.env.JWT_SECRET,
      databaseConfigured: !!(process.env.DB_HOST && process.env.DB_PASSWORD)
    }
  })
})

// POST /auth/refresh - Refresh JWT token (optional enhancement)
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    // Generate new token for current user
    const newToken = AuthService.generateToken(req.user)
    
    res.json({
      success: true,
      data: {
        token: newToken,
        expiresIn: process.env.JWT_EXPIRES_IN || '24h'
      }
    })
  } catch (error) {
    console.error('Token refresh error:', error.message)
    res.status(500).json({
      success: false,
      error: 'Failed to refresh token'
    })
  }
})

// PUT /auth/change-password - Change user password (self-service)
router.put('/change-password', authenticateToken, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Old password and new password are required'
      });
    }

    // Authenticate old password
    const user = await AuthService.authenticateUser(req.user.username, oldPassword);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Old password is incorrect'
      });
    }

    // Update password in database
    const connection = await database.getConnection().getConnection();
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await connection.execute(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [passwordHash, req.user.id]
    );
    connection.release();

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Change password error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to change password'
    });
  }
});

// PUT /auth/change-password - Change user password (admin service)
router.put('/auth/users/:id/password', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { newPassword } = req.body;
    const userId = req.params.id;

    if (!newPassword) {
      return res.status(400).json({ success: false, error: 'New password is required' });
    }

    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(newPassword, 10);

    const database = require('../config/database');
    const connection = await database.getConnection().getConnection();
    await connection.execute(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [passwordHash, userId]
    );
    connection.release();

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    console.error('Admin password reset error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});
module.exports = router;