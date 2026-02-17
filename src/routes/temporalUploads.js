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
     * POST /bulk/upload/:folder
     * Logic: Returns 202 instantly, processes NFS and Temporal in the background.
     */
    router.post("/upload/:folder", upload.array("images"), (req, res) => {
        const { folder } = req.params;
        const files = req.files;
        const batchId = nanoid();

        // 1. Immediate Validation (Synchronous)
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        // 2. Respond immediately - connection closes for the user HERE
        res.status(202).json({
            success: true,
            batchId,
            message: "Accepted: Processing started in background.",
            imageCount: files.length,
            folder
        });

        // 3. Background Task (Asynchronous / Non-blocking)
        setImmediate(async () => {
            try {
                // Ensure we have a base path from config or default
                const nfsBase = config.temporal?.nfsPath || '/nfs-storage';
                const batchDir = path.join(nfsBase, batchId);

                // Create directory on NFS
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

                console.log(`[Background] Files staged for batch ${batchId} at ${batchDir}`);

                // 4. Trigger Temporal
                // Verify client exists before calling
                if (temporalClient) {
                    await temporalClient.workflow.start('processBatchImages', {
                        taskQueue: config.temporal?.taskQueue || 'image-processing',
                        workflowId: `batch-${batchId}`,
                        args: [{ batchId, batchDir, images: imagePaths, folder }],
                    });
                    console.log(`[Background] Workflow started for batch ${batchId}`);
                } else {
                    console.warn(`[Background] Temporal Client not initialized. Batch ${batchId} staged but not started.`);
                }

            } catch (error) {
                // Since the client is long gone, we must log detailed errors here
                console.error(`[CRITICAL BACKGROUND FAILURE] Batch ${batchId}:`, error);
            }
        });
    });

    /**
     * Status route to check on the workflow
     */
    router.get('/status/:workflowId', async (req, res) => {
        if (!temporalClient) {
            return res.status(503).json({ error: "Temporal client not available" });
        }
        try {
            const handle = temporalClient.workflow.getHandle(req.params.workflowId);
            const description = await handle.describe();
            res.json({
                workflowId: req.params.workflowId,
                status: description.status.name,
                startTime: description.startTime
            });
        } catch (err) {
            res.status(404).json({ error: "Workflow not found", message: err.message });
        }
    });

    /**
     * Sanity check route
     */
    router.get("/test", async (req, res) => {
        res.json({ 
            success: true, 
            message: "Route is active.",
            nfsPath: config.temporal?.nfsPath || '/nfs-storage',
            temporalConnected: !!temporalClient
        });
    });

    return router;
};