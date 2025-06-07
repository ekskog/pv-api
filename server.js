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

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json({ limit: '500mb' }))
app.use(express.urlencoded({ limit: '500mb', extended: true }))

// Initialize database connection if not in demo mode
async function initializeDatabase() {
  const authMode = process.env.AUTH_MODE || 'demo'
  
  if (authMode === 'database') {
    try {
      console.log('🔌 Initializing database connection...')
      await database.initialize()
      console.log('✅ Database initialized successfully')
    } catch (error) {
      console.error('❌ Database initialization failed:', error.message)
      console.log('🔄 Falling back to demo mode')
      process.env.AUTH_MODE = 'demo'
    }
  } else {
    console.log('🎭 Running in demo authentication mode')
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
  try {
    // Test MinIO connection by listing buckets
    const buckets = await minioClient.listBuckets()
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      minio: {
        connected: true,
        buckets: buckets.length,
        endpoint: process.env.MINIO_ENDPOINT
      }
    })
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      minio: {
        connected: false,
        error: error.message
      }
    })
  }
})

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

    res.json({
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
    })
  } catch (error) {
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

// DELETE /buckets/:bucketName/folders - Delete a folder and all its contents (Admin only)
app.delete('/buckets/:bucketName/folders', authenticateToken, requireRole('admin'), async (req, res) => {
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

    // Ensure folder path ends with /
    const normalizedPath = folderPath.endsWith('/') ? folderPath : `${folderPath}/`
    
    // List all objects with this prefix
    const objectsToDelete = []
    const stream = minioClient.listObjectsV2(bucketName, normalizedPath, true)
    
    for await (const obj of stream) {
      objectsToDelete.push(obj.name)
    }

    if (objectsToDelete.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Folder not found or already empty'
      })
    }

    // Delete all objects in the folder
    await minioClient.removeObjects(bucketName, objectsToDelete)

    res.json({
      success: true,
      message: `Folder '${normalizedPath}' and ${objectsToDelete.length} objects deleted successfully`,
      data: {
        bucket: bucketName,
        folderPath: normalizedPath,
        deletedObjects: objectsToDelete.length
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
  try {
    const { bucketName } = req.params
    const { folderPath = '' } = req.body
    const files = req.files

    if (!files || files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No files provided'
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

    // Use UploadService to handle file processing and upload
    const { results: uploadResults, errors } = await uploadService.processMultipleFiles(files, bucketName, folderPath)

    // Return results
    const response = {
      success: errors.length === 0,
      data: {
        bucket: bucketName,
        folderPath: folderPath || '/',
        uploaded: uploadResults,
        uploadedCount: uploadResults.length,
        totalFiles: files.length
      }
    }

    if (errors.length > 0) {
      response.errors = errors
      response.errorCount = errors.length
    }

    const statusCode = errors.length === 0 ? 201 : (uploadResults.length > 0 ? 207 : 400)
    res.status(statusCode).json(response)

  } catch (error) {
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

// Start server with database initialization
async function startServer() {
  try {
    // Initialize database connection
    await initializeDatabase()
    
    // Start HTTP server
    app.listen(PORT, () => {
      const authMode = process.env.AUTH_MODE || 'demo'
      console.log(`🚀 PhotoVault API server running on port ${PORT}`)
      console.log(`📊 Health check: http://localhost:${PORT}/health`)
      console.log(`🔐 Authentication: http://localhost:${PORT}/auth/status`)
      console.log(`🗄️  MinIO endpoint: ${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`)
      console.log(`🎭 Auth Mode: ${authMode}`)
      
      if (authMode === 'demo') {
        console.log('👤 Demo users: admin/admin123, user/user123')
      }
    })
  } catch (error) {
    console.error('❌ Failed to start server:', error.message)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server...')
  if (process.env.AUTH_MODE === 'database') {
    await database.close()
  }
  process.exit(0)
})

// Start the server
startServer()
