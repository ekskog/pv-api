const express = require("express");
const router = express.Router();

module.exports = (temporalClient, config) => {
  
  // GET /bulk/test
  router.get("/test", async (req, res) => {
    try {
      // Check if client was injected
      if (!temporalClient) {
        return res.status(500).json({
          success: false,
          message: "Temporal Client not initialized",
          config_address: config.temporal.address
        });
      }

      // Simple connectivity check: describe the namespace
      // This confirms we can actually talk to the Temporal server
      const clientStatus = await temporalClient.workflowService.describeNamespace({
        namespace: "default"
      });

      res.json({
        success: true,
        message: "Hello World! Temporal integration is online.",
        details: {
          namespace: "default",
          taskQueue: config.temporal.taskQueue,
          nfsPath: config.temporal.nfsPath,
          status: "connected"
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Temporal connection failed",
        error: error.message
      });
    }
  });

  return router;
};