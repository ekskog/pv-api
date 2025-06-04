require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { Client } = require('minio')

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// MinIO Client Configuration
const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: parseInt(process.env.MINIO_PORT),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY
})

// Test route
app.get('/', (req, res) => {
  res.json({
    message: 'PhotoVault API is running!',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  })
})

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

// MinIO API Routes

// GET /buckets - List all buckets
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

// POST /buckets - Create a new bucket
app.post('/buckets', async (req, res) => {
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

// GET /buckets/:bucketName/objects - List objects in a bucket (with optional prefix for folders)
app.get('/buckets/:bucketName/objects', async (req, res) => {
  try {
    const { bucketName } = req.params
    const { prefix = '', delimiter = '/' } = req.query

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

    // Use non-recursive listing to get immediate children only
    const stream = minioClient.listObjectsV2(bucketName, prefix, false, delimiter)
    
    for await (const obj of stream) {
      if (obj.prefix) {
        // This is a folder/prefix - remove the trailing slash for display
        const folderName = obj.prefix.replace(/\/$/, '')
        const displayName = prefix ? folderName.substring(prefix.length) : folderName
        
        folders.push({
          name: displayName,
          fullPath: obj.prefix,
          type: 'folder'
        })
      } else {
        // This is a file/object - skip empty folder marker objects
        if (!obj.name.endsWith('/') || obj.size > 0) {
          const displayName = prefix ? obj.name.substring(prefix.length) : obj.name
          
          objects.push({
            name: displayName,
            fullPath: obj.name,
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

// POST /buckets/:bucketName/folders - Create a folder (by creating an empty object with trailing slash)
app.post('/buckets/:bucketName/folders', async (req, res) => {
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
    
    // Check if folder already exists by looking for the exact folder marker object
    try {
      await minioClient.statObject(bucketName, normalizedPath)
      return res.status(409).json({
        success: false,
        error: 'Folder already exists'
      })
    } catch (err) {
      // Folder doesn't exist, which is what we want
      if (err.code !== 'NotFound') {
        throw err
      }
    }
    
    // Create an empty object to represent the folder
    const emptyBuffer = Buffer.alloc(0)
    await minioClient.putObject(bucketName, normalizedPath, emptyBuffer)

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

// DELETE /buckets/:bucketName/folders - Delete a folder and all its contents
app.delete('/buckets/:bucketName/folders', async (req, res) => {
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 PhotoVault API server running on port ${PORT}`)
  console.log(`📊 Health check: http://localhost:${PORT}/health`)
  console.log(`🗄️  MinIO endpoint: ${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`)
})
