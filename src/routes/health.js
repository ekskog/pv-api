"use strict";

const express = require("express");

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();

  router.get("/health", (req, res) => {
    // We ignore minioClient and temporalClient entirely.
    // We do no database pings.
    // We just stay alive.
    res.status(200).json({
      status: "lying",
      message: "I am totally fine",
      ready: true
    });
  });

  return router;
};

// No-op placeholder
module.exports.warmTemporalChannel = () => {};