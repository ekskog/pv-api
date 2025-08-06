const express = require("express");
const router = express.Router();
const database = require("../config/database");

router.post("/register", async (req, res) => {
  try {
    const { username, password, email } = req.body;
    console.log("Registering user:", username, email);

    // Validate input
    if (!username || !password || !email) {
      return res.status(400).json({
        success: false,
        error: "Username, password, and email are required",
      });
    }

    // Register user
    const user = await database.createUserIfNotExists({ username, password, email, role: "user" });

    if (!user) {
      return res.status(500).json({
        success: false,
        error: "User registration failed",
      });
    }

    // Return success response
    res.json({
      success: true,
      message: "Registration successful",
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
        },
      },
    });
  } catch (error) {
    console.error("Registration error:", error.message);
    res.status(500).json({
      success: false,
      error: "Internal server error during registration",
    });
  }
});

module.exports = router;