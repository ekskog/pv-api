const express = require("express");
const router = express.Router();
const multer = require("multer");
const { nanoid } = require("nanoid");
const mime = require('mime-types');
const fs = require('fs').promises;
const path = require('path');

// Use memory storage to handle the manual write to NFS
const upload = multer({ storage: multer.memoryStorage() });

module.exports = (temporalClient, config) => {
  
  /**
   * POST /upload/:folder
   * Logic: Ingest files, write to NFS, but HOLD the Temporal workflow call.
   */
  router.post("/upload/:folder", upload.array("images"), async (req, res) => {
    try {
      const { folder } = req.params; 
      const files = req.files;

      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const batchId = nanoid();
      const workflowId = `batch-${batchId}`;
      const batchDir = path.join(config.temporal.nfsPath || '/nfs-storage', batchId);

      // Create the directory on the NFS
      await fs.mkdir(batchDir, { recursive: true });

      // Map and write the files to the NFS
      const imagePaths = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(batchDir, file.originalname);
          await fs.writeFile(filePath, file.buffer);
          
          const detectedType = mime.lookup(file.originalname);
          return {
            filename: file.originalname,
            path: filePath,
            contentType: detectedType || file.mimetype,
          };
        })
      );

      /* * TEMPORAL CALL IS CURRENTLY DISABLED FOR STAGING TEST
       * await temporalClient.workflow.start('processBatchImages', {
        taskQueue: config.temporal.taskQueue || 'image-processing',
        workflowId,
        args: [{ batchId, batchDir, images: imagePaths, folder }],
      });
      */

      res.json({
        success: true,
        message: "STAGING TEST: Files written to NFS successfully.",
        folder,
        batchId,
        batchDir,
        imageCount: imagePaths.length,
        filesSaved: imagePaths.map(p => p.filename)
      });

    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: 'Failed to write files to NFS', details: error.message });
    }
  });

  // Keep the status route (it will just return 404 or error since no workflow started)
  router.get('/status/:workflowId', async (req, res) => {
     res.status(501).json({ message: "Workflow integration currently disabled for staging test" });
  });

  // Keep your sanity check
  router.get("/test", async (req, res) => {
    res.json({ success: true, message: "Route is active and NFS is ready for staging." });
  });

  return router;
};