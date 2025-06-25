require('dotenv').config()
const express = require('express')
const cors = require('cors')
const multer = require('multer')
const { Client } = require('minio')

// Import authentication components
const database = require('./config/database')
const authRoutes = require('./routes/auth')
const { authenticateToken, requireRole } = require('./middleware/auth')

// Import services
const UploadService = require('./services/upload-service')
const AvifConverterService = require('./services/avif-converter-service')
const redisService = require('./services/redis-service')
const jobService = require('./services/job-service')

const app = express()
const PORT = process.env.PORT || 3001

// CORS Configuration - Allow frontend domain
const corsOptions = {
  origin: [
    'https://photos.hbvu.su',
    'http://localhost:5173', // For development
    'http://localhost:3000'  // Alternative dev port
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token']
}

// Middleware
app.use(cors(corsOptions))
app.use(express.json({ limit: '1gb' }))
app.use(express.urlencoded({ limit: '1gb', extended: true }))

// Initialize database connection if not in demo mode
async function initializeDatabase() {
  const authMode = process.env.AUTH_MODE || 'demo'
  
  if (authMode === 'database') {
    try {
      await database.initialize()
    } catch (error) {
      console.error('Database initialization failed:', error.message)
      process.env.AUTH_MODE = 'demo'
    }
  } else {
    console.log('Running in demo authentication mode')
  }
}

// Configure multer for file uploads (store in memory)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB limit for large HEIC files
  }
})

// MinIO Client Configuration
const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: parseInt(process.env.MINIO_PORT),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY
})

// Initialize Upload Service
const uploadService = new UploadService(minioClient)

// Initialize AVIF Converter Service (Step 2: Test integration)
const avifConverterService = new AvifConverterService()

// Test route
app.get('/', (req, res) => {
  const authMode = process.env.AUTH_MODE || 'demo'
  res.json({
    message: 'PhotoVault API is running!',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    authMode: authMode
  })
})

// Authentication routes
app.use('/auth', authRoutes)

// Health check route
app.get('/health', async (req, res) => {
  console.log(`[HEALTH] Health check request received from ${req.ip} at ${new Date().toISOString()}`)
  try {
    console.log('[HEALTH] Testing MinIO connection...')
    // Test MinIO connection by listing buckets
    const buckets = await minioClient.listBuckets()
    console.log(`[HEALTH] MinIO connection successful, found ${buckets.length} buckets`)
    
    console.log('[HEALTH] Testing Redis connection...')
    // Test Redis connection
    const redisStatus = await redisService.getConnectionStatus()
    console.log(`[HEALTH] Redis connection status: ${redisStatus.connected ? 'connected' : 'disconnected'}`)
    
    const healthStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      minio: {
        connected: true,
        buckets: buckets.length,
        endpoint: process.env.MINIO_ENDPOINT
      },
      redis: redisStatus
    }
    
    // If Redis is not connected, still return healthy but with warning
    if (!redisStatus.connected) {
      healthStatus.status = 'degraded'
      healthStatus.warnings = ['Redis connection unavailable - async uploads will be disabled']
    }
    
    console.log('[HEALTH] Sending healthy response')
    res.json(healthStatus)
  } catch (error) {
    console.log(`[HEALTH] Error during health check: ${error.message}`)
    const redisStatus = await redisService.getConnectionStatus()
    
    console.log('[HEALTH] Sending unhealthy response')
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      minio: {
        connected: false,
        error: error.message
      },
      redis: redisStatus
    })
  }
})

// GET /upload/status/:jobId - Get upload job status
app.get('/upload/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    if (!jobService.isAvailable()) {
      return res.status(503).json({
        success: false,
        error: 'Job service unavailable - Redis not connected'
      });
    }

    const job = await jobService.getJobStatus(jobId);
    
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    res.json({
      success: true,
      data: job
    });
  } catch (error) {
    console.error(`[API] Error getting job status for ${req.params.jobId}:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// MinIO API Routes (Protected)

// GET /buckets - List all buckets (public access for album browsing)
app.get('/buckets', async (req, res) => {
  try {
    const buckets = await minioClient.listBuckets()
    res.json({
      success: true,
      data: buckets,
      count: buckets.length
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// POST /buckets - Create a new bucket (Admin only)
app.post('/buckets', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { bucketName, region = 'us-east-1' } = req.body
    
    if (!bucketName) {
      return res.status(400).json({
        success: false,
        error: 'Bucket name is required'
      })
    }

    // Check if bucket already exists
    const bucketExists = await minioClient.bucketExists(bucketName)
    if (bucketExists) {
      return res.status(409).json({
        success: false,
        error: 'Bucket already exists'
      })
    }

    await minioClient.makeBucket(bucketName, region)
    res.status(201).json({
      success: true,
      message: `Bucket '${bucketName}' created successfully`,
      data: { bucketName, region }
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// GET /buckets/:bucketName/objects - List objects in a bucket (Public access for album browsing)
app.get('/buckets/:bucketName/objects', async (req, res) => {
  
console.log(">> GET /buckets/:bucketName/objects called with params:", req.params, "and query:", req.query)
  
  try {
    const { bucketName } = req.params
    const { prefix = '', recursive = 'false' } = req.query

    // Check if bucket exists
    const bucketExists = await minioClient.bucketExists(bucketName)
    if (!bucketExists) {
      return res.status(404).json({
        success: false,
        error: 'Bucket not found'
      })
    }

    const objects = []
    const folders = []
    const isRecursive = recursive === 'true'

    // For recursive: use listObjects with recursive=true, no delimiter  
    // For non-recursive: use listObjectsV2 with delimiter to show folders
    let stream
    
    if (isRecursive) {
      // Recursive listing - get all objects
      stream = minioClient.listObjects(bucketName, prefix, true)
      
      for await (const obj of stream) {
        // Skip folder placeholder files from the listing
        if (obj.name.endsWith('/.folderkeeper')) {
          continueapt 
        }
        
        objects.push({
          name: obj.name,
          size: obj.size,
          lastModified: obj.lastModified,
          etag: obj.etag,
          type: 'file'
        })
      }
    } else {
      // Non-recursive listing - show folder structure
      stream = minioClient.listObjectsV2(bucketName, prefix, false, '/')
      
      for await (const obj of stream) {
        if (obj.prefix) {
          // This is a folder/prefix
          folders.push({
            name: obj.prefix,
            type: 'folder'
          })
        } else {
          // Skip folder placeholder files from the listing
          if (obj.name.endsWith('/.folderkeeper')) {
            continue
          }
          
          // This is a file/object
          objects.push({
            name: obj.name,
            size: obj.size,
            lastModified: obj.lastModified,
            etag: obj.etag,
            type: 'file'
          })
        }
      }
    }

    const responseData = {
      success: true,
      data: {
        bucket: bucketName,
        prefix: prefix || '/',
        recursive: isRecursive,
        folders: folders,
        objects: objects,
        totalFolders: folders.length,
        totalObjects: objects.length
      }
    }
    
    /*
    debugService.server.response('GET /buckets/:bucketName/objects', {
      success: responseData.success,
      bucket: responseData.data.bucket,
      prefix: responseData.data.prefix,
      recursive: responseData.data.recursive,
      totalObjects: responseData.data.totalObjects,
      totalFolders: responseData.data.totalFolders,
      objectsList: responseData.data.objects.length > 0 ? 
        responseData.data.objects.map((obj, i) => `${i + 1}. ${obj.name} (${obj.size} bytes)`) : 
        ['No objects found']
    })
        */
    
    res.json(responseData)
  } catch (error) {
    // debugService.server.error('Error in GET /buckets/:bucketName/objects:', error.message)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// POST /buckets/:bucketName/folders - Create a folder (Admin only)
app.post('/buckets/:bucketName/folders', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { bucketName } = req.params
    const { folderPath } = req.body

    if (!folderPath) {
      return res.status(400).json({
        success: false,
        error: 'Folder path is required'
      })
    }

    // Check if bucket exists
    const bucketExists = await minioClient.bucketExists(bucketName)
    if (!bucketExists) {
      return res.status(404).json({
        success: false,
        error: 'Bucket not found'
      })
    }

    // Clean the folder path: remove leading/trailing slashes, then ensure it ends with /
    let cleanPath = folderPath.trim()
    cleanPath = cleanPath.replace(/^\/+/, '') // Remove leading slashes
    cleanPath = cleanPath.replace(/\/+$/, '') // Remove trailing slashes
    cleanPath = cleanPath.replace(/\/+/g, '/') // Replace multiple slashes with single slash
    
    if (!cleanPath) {
      return res.status(400).json({
        success: false,
        error: 'Invalid folder path'
      })
    }
    
    const normalizedPath = `${cleanPath}/`
    
    // Check if folder already exists by looking for any objects with this prefix
    const existingObjects = []
    const stream = minioClient.listObjectsV2(bucketName, normalizedPath, false)
    
    for await (const obj of stream) {
      existingObjects.push(obj)
      break // We only need to check if any object exists with this prefix
    }
    
    if (existingObjects.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Folder already exists'
      })
    }
    
    // Instead of creating an empty folder marker, create a hidden placeholder file
    // This ensures the folder exists without creating MinIO metadata issues
    const placeholderPath = `${normalizedPath}.folderkeeper`
    const placeholderContent = Buffer.from(JSON.stringify({
      type: 'folder_placeholder',
      created: new Date().toISOString(),
      folderName: cleanPath
    }))
    
    await minioClient.putObject(bucketName, placeholderPath, placeholderContent, placeholderContent.length, {
      'Content-Type': 'application/json',
      'X-Amz-Meta-Type': 'folder-placeholder'
    })

    res.status(201).json({
      success: true,
      message: `Folder '${cleanPath}' created successfully`,
      data: {
        bucket: bucketName,
        folderPath: normalizedPath,
        folderName: cleanPath
      }
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// POST /buckets/:bucketName/upload - Upload file(s) to a bucket with optional folder path
app.post('/buckets/:bucketName/upload', authenticateToken, upload.array('files'), async (req, res) => {
  const startTime = Date.now()
  
  try {
    const { bucketName } = req.params
    const { folderPath = '' } = req.body
    const files = req.files

    console.log(`[UPLOAD] Upload request received:`, {
      bucket: bucketName,
      folder: folderPath || 'root',
      filesCount: files ? files.length : 0,
      user: req.user?.username || 'unknown',
      timestamp: new Date().toISOString()
    })

    if (!files || files.length === 0) {
      console.error('[UPLOAD] Upload failed: No files provided')
      return res.status(400).json({
        success: false,
        error: 'No files provided'
      })
    }

    console.log('[UPLOAD] Files to upload:', files.map((file, index) => 
      `${index + 1}. ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)}MB, ${file.mimetype})`
    ))

    // Check if bucket exists
    console.log(`[UPLOAD] Checking if bucket '${bucketName}' exists...`)
    const bucketExists = await minioClient.bucketExists(bucketName)
    if (!bucketExists) {
      console.error(`[UPLOAD] Upload failed: Bucket '${bucketName}' not found`)
      return res.status(404).json({
        success: false,
        error: 'Bucket not found'
      })
    }

    console.log(`[UPLOAD] Bucket '${bucketName}' exists - proceeding with upload processing`)

    // **PHASE 3: FIXED Async Upload Implementation**
    // Create job immediately and return job ID, then process in background
    if (jobService.isAvailable()) {
      console.log('[UPLOAD] Creating async job for upload processing...')
      
      const jobData = {
        bucketName,
        folderPath: folderPath || '',
        userId: req.user?.id || req.user?.username || 'unknown',
        files: files.map(file => ({
          originalName: file.originalname,
          size: file.size,
          mimetype: file.mimetype
        })),
        progress: { processed: 0, total: files.length }
      };

      const job = await jobService.createJob(jobData);
      console.log(`[UPLOAD] Created async job: ${job.id} - returning immediately`)
      
      // **RETURN JOB ID IMMEDIATELY** 
      const quickResponse = {
        success: true,
        message: 'Upload job created successfully',
        data: {
          bucket: bucketName,
          folderPath: folderPath || '/',
          jobId: job.id,
          status: 'queued',
          totalFiles: files.length,
          processingAsync: true
        }
      };
      
      console.log(`[UPLOAD] Returning job ID immediately: ${job.id}`)
      res.status(202).json(quickResponse); // 202 Accepted
      
      // **PROCESS FILES IN BACKGROUND (async, non-blocking)**
      processFilesInBackground(job.id, files, bucketName, folderPath, uploadService, jobService, startTime);
      
      return; // Early return - response already sent
    }

    // **FALLBACK: Synchronous processing if Redis not available**
    console.log('[UPLOAD] Redis not available - processing synchronously')
    const { results: uploadResults, errors } = await uploadService.processMultipleFiles(files, bucketName, folderPath)

    const processingTime = Date.now() - startTime
    console.log(`[UPLOAD] Upload processing complete in ${processingTime}ms:`, {
      totalFilesProcessed: files.length,
      successfulUploads: uploadResults.length,
      failedUploads: errors.length
    })
    
    if (uploadResults.length > 0) {
      console.log('[UPLOAD] Successfully uploaded files:', uploadResults.map((result, index) => 
        `${index + 1}. ${result.objectName} (${(result.size / 1024 / 1024).toFixed(2)}MB, ${result.mimetype})`
      ))
    }
    
    if (errors.length > 0) {
      console.error('[UPLOAD] Failed uploads:', errors.map((error, index) => 
        `${index + 1}. ${error.filename}: ${error.error}`
      ))
    }

    // Update job status to 'completed' or 'failed' if job exists
    if (job) {
      const finalStatus = errors.length === 0 ? 'completed' : 'failed';
      await jobService.updateJobStatus(job.id, {
        status: finalStatus,
        progress: { processed: uploadResults.length, total: files.length },
        completedAt: new Date().toISOString(),
        results: uploadResults,
        errors: errors.length > 0 ? errors : undefined
      });
      console.log(`[UPLOAD] Updated job ${job.id} status to: ${finalStatus}`)
    }

    // Return results
    const response = {
      success: errors.length === 0,
      data: {
        bucket: bucketName,
        folderPath: folderPath || '/',
        uploaded: uploadResults,
        uploadedCount: uploadResults.length,
        totalFiles: files.length,
        // Include job ID if async processing was used
        jobId: job ? job.id : undefined
      }
    }

    if (errors.length > 0) {
      response.errors = errors
      response.errorCount = errors.length
    }

    const statusCode = errors.length === 0 ? 201 : (uploadResults.length > 0 ? 207 : 400)
    
    console.log(`[UPLOAD] Upload response:`, {
      statusCode: statusCode,
      success: response.success,
      filesUploaded: `${uploadResults.length}/${files.length}`,
      totalTime: `${Date.now() - startTime}ms`
    })
    console.log('[UPLOAD] Upload request completed')
    
    res.status(statusCode).json(response)

  } catch (error) {
    const errorTime = Date.now() - startTime
    console.error(`[UPLOAD] Upload error occurred after ${errorTime}ms:`, {
      error: error.message,
      stack: error.stack
    })
    console.error('[UPLOAD] Upload request failed')
    
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// GET /buckets/:bucketName/download - Get/download a specific object (Public access for images)
app.get('/buckets/:bucketName/download', async (req, res) => {
  try {
    const { bucketName } = req.params
    const { object } = req.query

    if (!object) {
      return res.status(400).json({
        success: false,
        error: 'Object name is required'
      })
    }

    // Check if bucket exists
    const bucketExists = await minioClient.bucketExists(bucketName)
    if (!bucketExists) {
      return res.status(404).json({
        success: false,
        error: 'Bucket not found'
      })
    }

    // Get object metadata first to check if it exists
    let objectStat
    try {
      objectStat = await minioClient.statObject(bucketName, object)
    } catch (error) {
      if (error.code === 'NotFound') {
        return res.status(404).json({
          success: false,
          error: 'Object not found'
        })
      }
      throw error
    }

    // Stream the object directly to the response
    const objectStream = await minioClient.getObject(bucketName, object)
    
    // Set appropriate headers
    res.setHeader('Content-Type', objectStat.metaData['content-type'] || 'application/octet-stream')
    res.setHeader('Content-Length', objectStat.size)
    res.setHeader('Last-Modified', objectStat.lastModified)
    res.setHeader('ETag', objectStat.etag)
    
    // Optional: Set Content-Disposition to download file with original name
    const filename = object.split('/').pop()
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`)

    // Pipe the object stream to response
    objectStream.pipe(res)

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// **Background Processing Function**
async function processFilesInBackground(jobId, files, bucketName, folderPath, uploadService, jobService, startTime) {
  try {
    console.log(`[BACKGROUND] Starting background processing for job ${jobId}`)
    
    // Update job status to 'processing'
    await jobService.updateJobStatus(jobId, { 
      status: 'processing',
      startedAt: new Date().toISOString()
    });

    // Process files
    const { results: uploadResults, errors } = await uploadService.processMultipleFiles(files, bucketName, folderPath)

    const processingTime = Date.now() - startTime
    console.log(`[BACKGROUND] Job ${jobId} processing complete in ${processingTime}ms`)
    
    // Update final job status
    const finalStatus = errors.length === 0 ? 'completed' : 'failed';
    await jobService.updateJobStatus(jobId, {
      status: finalStatus,
      progress: { processed: uploadResults.length, total: files.length },
      completedAt: new Date().toISOString(),
      results: uploadResults,
      errors: errors.length > 0 ? errors : undefined
    });
    
    console.log(`[BACKGROUND] Job ${jobId} finished: ${finalStatus}`)
  } catch (error) {
    console.error(`[BACKGROUND] Job ${jobId} failed:`, error.message);
    await jobService.updateJobStatus(jobId, {
      status: 'failed',
      error: error.message,
      completedAt: new Date().toISOString()
    });
  }
}

// Start server with database initialization
async function startServer() {
  try {
    // Initialize database connection
    await initializeDatabase()
    
    // Initialize Redis connection
    console.log('Initializing Redis connection...')
    await redisService.connect()
    
    // Start HTTP server
    app.listen(PORT, () => {
      const authMode = process.env.AUTH_MODE || 'demo'
      console.log(`\nStarting PhotoVault ${new Date()}...`)
      console.log(`PhotoVault API server running on port ${PORT}`)
      console.log(`Health check: http://localhost:${PORT}/health`)
      console.log(`Authentication: http://localhost:${PORT}/auth/status`)
      console.log(`MinIO endpoint: ${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`)
      console.log(`Auth Mode: ${authMode}`)
      
      if (authMode === 'demo') {
        console.log('Demo users available: admin/admin123, user/user123')
      }
    })
  } catch (error) {
    console.error('Failed to start server:', error.message)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...')
  if (process.env.AUTH_MODE === 'database') {
    await database.close()
  }
  await redisService.disconnect()
  process.exit(0)
})

// Start the server
startServer()
