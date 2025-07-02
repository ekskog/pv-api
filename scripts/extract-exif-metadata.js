#!/usr/bin/env node

/**
 * EXIF Metadata Extraction Script
 * 
 * This script processes existing images in MinIO to extract EXIF metadata
 * and update object metadata without re-uploading the files.
 * 
 * Usage:
 *   node extract-exif-metadata.js --bucket=photovault --batch-size=10
 *   node extract-exif-metadata.js --bucket=photovault --prefix=2024/ --dry-run
 */

require('dotenv').config()
const { Client } = require('minio')
const ExifReader = require('exifreader')
const fs = require('fs').promises
const path = require('path')
const os = require('os')

// Command line arguments
const args = process.argv.slice(2)
const getArg = (name) => {
  const arg = args.find(a => a.startsWith(`--${name}=`))
  return arg ? arg.split('=')[1] : null
}

const BUCKET_NAME = getArg('bucket') || process.env.DEFAULT_BUCKET || 'photovault'
const PREFIX = getArg('prefix') || ''
const BATCH_SIZE = parseInt(getArg('batch-size')) || 5
const DRY_RUN = args.includes('--dry-run')
const TEMP_DIR = path.join(os.tmpdir(), 'photovault-exif-extraction')

// Image file extensions to process
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.heic', '.heif']

// MinIO Client Configuration
const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: parseInt(process.env.MINIO_PORT),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY
})

class ExifMetadataExtractor {
  constructor() {
    this.stats = {
      totalFiles: 0,
      processed: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      startTime: Date.now()
    }
  }

  /**
   * Check if file is an image based on extension
   */
  isImageFile(filename) {
    const ext = path.extname(filename).toLowerCase()
    return IMAGE_EXTENSIONS.includes(ext)
  }

  /**
   * Check if object already has EXIF metadata
   */
  hasExifMetadata(objectStat) {
    const metadata = objectStat.metaData || {}
    return !!(metadata['x-amz-meta-date-taken'] || metadata['x-amz-meta-has-exif'])
  }

  /**
   * Extract EXIF data from image buffer
   */
  extractExifData(imageBuffer, filename) {
    try {
      const tags = ExifReader.load(imageBuffer)
      
      const exifData = {
        dateTaken: null,
        cameraMake: null,
        cameraModel: null,
        gpsCoordinates: null,
        hasExif: false
      }

      // Extract date taken (priority order)
      if (tags.DateTimeOriginal?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTimeOriginal.description)
        exifData.hasExif = true
      } else if (tags.DateTime?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTime.description)
        exifData.hasExif = true
      } else if (tags.DateTimeDigitized?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTimeDigitized.description)
        exifData.hasExif = true
      }

      // Extract camera information
      if (tags.Make?.description) {
        exifData.cameraMake = tags.Make.description.trim()
        exifData.hasExif = true
      }

      if (tags.Model?.description) {
        exifData.cameraModel = tags.Model.description.trim()
        exifData.hasExif = true
      }

      // Extract GPS coordinates
      if (tags.GPSLatitude && tags.GPSLongitude) {
        const lat = this.parseGPSCoordinate(tags.GPSLatitude, tags.GPSLatitudeRef?.description)
        const lon = this.parseGPSCoordinate(tags.GPSLongitude, tags.GPSLongitudeRef?.description)
        if (lat !== null && lon !== null) {
          exifData.gpsCoordinates = `${lat},${lon}`
          exifData.hasExif = true
        }
      }

      console.log(`[EXIF] Extracted from ${filename}:`, {
        dateTaken: exifData.dateTaken,
        camera: exifData.cameraMake && exifData.cameraModel ? `${exifData.cameraMake} ${exifData.cameraModel}` : null,
        hasGPS: !!exifData.gpsCoordinates
      })

      return exifData

    } catch (error) {
      console.warn(`[EXIF] Failed to extract EXIF from ${filename}: ${error.message}`)
      return { hasExif: false }
    }
  }

  /**
   * Parse EXIF date string to ISO format
   */
  parseExifDate(exifDateString) {
    try {
      // EXIF date format: "2024:12:25 10:30:45"
      const cleanDate = exifDateString.replace(/(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
      const date = new Date(cleanDate)
      return date.toISOString()
    } catch (error) {
      console.warn(`[EXIF] Failed to parse date: ${exifDateString}`)
      return null
    }
  }

  /**
   * Parse GPS coordinate from EXIF data
   */
  parseGPSCoordinate(coordinate, ref) {
    try {
      if (!coordinate.description) return null
      
      const coords = coordinate.description.split(',').map(c => parseFloat(c.trim()))
      if (coords.length !== 3) return null
      
      let decimal = coords[0] + coords[1]/60 + coords[2]/3600
      
      // Apply hemisphere reference
      if (ref && (ref === 'S' || ref === 'W')) {
        decimal = -decimal
      }
      
      return decimal
    } catch (error) {
      return null
    }
  }

  /**
   * Create MinIO metadata object from EXIF data
   */
  createMetadataObject(exifData, existingMetadata = {}) {
    const metadata = { ...existingMetadata }

    if (exifData.dateTaken) {
      metadata['X-Amz-Meta-Date-Taken'] = exifData.dateTaken
    }

    if (exifData.cameraMake) {
      metadata['X-Amz-Meta-Camera-Make'] = exifData.cameraMake
    }

    if (exifData.cameraModel) {
      metadata['X-Amz-Meta-Camera-Model'] = exifData.cameraModel
    }

    if (exifData.gpsCoordinates) {
      metadata['X-Amz-Meta-GPS-Coordinates'] = exifData.gpsCoordinates
    }

    metadata['X-Amz-Meta-Has-EXIF'] = exifData.hasExif ? 'true' : 'false'
    metadata['X-Amz-Meta-EXIF-Processed'] = new Date().toISOString()

    return metadata
  }

  /**
   * Download partial file content (just enough for EXIF)
   */
  async downloadImageHeaders(bucketName, objectName) {
    try {
      // Download first 64KB which should contain EXIF data for most images
      const stream = await minioClient.getPartialObject(bucketName, objectName, 0, 65536)
      
      const chunks = []
      for await (const chunk of stream) {
        chunks.push(chunk)
      }
      
      return Buffer.concat(chunks)
    } catch (error) {
      // If partial download fails, download the full file (for smaller images)
      console.warn(`[DOWNLOAD] Partial download failed for ${objectName}, downloading full file`)
      const stream = await minioClient.getObject(bucketName, objectName)
      
      const chunks = []
      for await (const chunk of stream) {
        chunks.push(chunk)
      }
      
      return Buffer.concat(chunks)
    }
  }

  /**
   * Update object metadata in MinIO using copy operation
   */
  async updateObjectMetadata(bucketName, objectName, newMetadata) {
    try {
      const copyConditions = new minioClient.CopyConditions()
      
      await minioClient.copyObject(
        bucketName,           // destination bucket
        objectName,           // destination object
        `/${bucketName}/${objectName}`, // source
        copyConditions,       // copy conditions
        newMetadata          // new metadata
      )
      
      console.log(`[UPDATE] Successfully updated metadata for ${objectName}`)
      return true
    } catch (error) {
      console.error(`[UPDATE] Failed to update metadata for ${objectName}: ${error.message}`)
      return false
    }
  }

  /**
   * Process a single image file
   */
  async processImage(bucketName, objectName, objectStat) {
    try {
      console.log(`[PROCESS] Processing ${objectName}...`)

      // Check if already processed
      if (this.hasExifMetadata(objectStat)) {
        console.log(`[SKIP] ${objectName} already has EXIF metadata`)
        this.stats.skipped++
        return true
      }

      // Download image headers
      const imageBuffer = await this.downloadImageHeaders(bucketName, objectName)
      
      // Extract EXIF data
      const exifData = this.extractExifData(imageBuffer, objectName)
      
      // Create new metadata
      const newMetadata = this.createMetadataObject(exifData, objectStat.metaData)
      
      if (DRY_RUN) {
        console.log(`[DRY-RUN] Would update ${objectName} with:`, newMetadata)
        this.stats.updated++
        return true
      }

      // Update object metadata
      const success = await this.updateObjectMetadata(bucketName, objectName, newMetadata)
      
      if (success) {
        this.stats.updated++
      } else {
        this.stats.errors++
      }

      return success

    } catch (error) {
      console.error(`[ERROR] Failed to process ${objectName}: ${error.message}`)
      this.stats.errors++
      return false
    } finally {
      this.stats.processed++
    }
  }

  /**
   * Get list of image objects to process
   */
  async getImageObjects(bucketName, prefix = '') {
    const objects = []
    
    console.log(`[SCAN] Scanning bucket '${bucketName}' with prefix '${prefix}'...`)
    
    const stream = minioClient.listObjects(bucketName, prefix, true)
    
    for await (const obj of stream) {
      if (this.isImageFile(obj.name)) {
        objects.push(obj)
      }
    }
    
    console.log(`[SCAN] Found ${objects.length} image files`)
    return objects
  }

  /**
   * Process images in batches
   */
  async processBatch(bucketName, objects) {
    const batches = []
    for (let i = 0; i < objects.length; i += BATCH_SIZE) {
      batches.push(objects.slice(i, i + BATCH_SIZE))
    }

    console.log(`[BATCH] Processing ${objects.length} images in ${batches.length} batches of ${BATCH_SIZE}`)

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      console.log(`\n[BATCH] Processing batch ${i + 1}/${batches.length} (${batch.length} files)`)

      // Process batch in parallel
      const promises = batch.map(async (obj) => {
        try {
          // Get object metadata
          const objectStat = await minioClient.statObject(bucketName, obj.name)
          return await this.processImage(bucketName, obj.name, objectStat)
        } catch (error) {
          console.error(`[ERROR] Failed to get stats for ${obj.name}: ${error.message}`)
          this.stats.errors++
          return false
        }
      })

      await Promise.allSettled(promises)

      // Progress update
      const progress = Math.round((this.stats.processed / objects.length) * 100)
      console.log(`[PROGRESS] ${progress}% complete (${this.stats.processed}/${objects.length})`)
    }
  }

  /**
   * Print final statistics
   */
  printStats() {
    const duration = (Date.now() - this.stats.startTime) / 1000
    
    console.log('\n' + '='.repeat(50))
    console.log('EXIF EXTRACTION COMPLETE')
    console.log('='.repeat(50))
    console.log(`Total files found: ${this.stats.totalFiles}`)
    console.log(`Files processed: ${this.stats.processed}`)
    console.log(`Files updated: ${this.stats.updated}`)
    console.log(`Files skipped: ${this.stats.skipped}`)
    console.log(`Errors: ${this.stats.errors}`)
    console.log(`Duration: ${duration.toFixed(1)}s`)
    console.log(`Rate: ${(this.stats.processed / duration).toFixed(1)} files/sec`)
    
    if (DRY_RUN) {
      console.log('\n⚠️  DRY RUN MODE - No changes were made')
    }
  }

  /**
   * Main execution function
   */
  async run() {
    try {
      console.log('📸 EXIF Metadata Extraction Script')
      console.log('=====================================')
      console.log(`Bucket: ${BUCKET_NAME}`)
      console.log(`Prefix: ${PREFIX || '(none)'}`)
      console.log(`Batch size: ${BATCH_SIZE}`)
      console.log(`Dry run: ${DRY_RUN}`)
      console.log('')

      // Check bucket exists
      const bucketExists = await minioClient.bucketExists(BUCKET_NAME)
      if (!bucketExists) {
        throw new Error(`Bucket '${BUCKET_NAME}' does not exist`)
      }

      // Get list of images
      const objects = await this.getImageObjects(BUCKET_NAME, PREFIX)
      this.stats.totalFiles = objects.length

      if (objects.length === 0) {
        console.log('No image files found to process')
        return
      }

      // Process in batches
      await this.processBatch(BUCKET_NAME, objects)

      // Print final stats
      this.printStats()

    } catch (error) {
      console.error(`[FATAL] Script failed: ${error.message}`)
      process.exit(1)
    }
  }
}

// Help text
function showHelp() {
  console.log(`
EXIF Metadata Extraction Script

Usage:
  node extract-exif-metadata.js [OPTIONS]

Options:
  --bucket=NAME         MinIO bucket name (default: photovault)
  --prefix=PATH         Only process objects with this prefix
  --batch-size=NUM      Number of files to process in parallel (default: 5)
  --dry-run            Show what would be done without making changes
  --help               Show this help message

Examples:
  # Process all images in default bucket
  node extract-exif-metadata.js

  # Process only 2024 photos with small batch size
  node extract-exif-metadata.js --bucket=photos --prefix=2024/ --batch-size=3

  # Test run without making changes
  node extract-exif-metadata.js --dry-run

Environment Variables:
  MINIO_ENDPOINT       MinIO server endpoint
  MINIO_PORT           MinIO server port
  MINIO_USE_SSL        Use SSL (true/false)
  MINIO_ACCESS_KEY     MinIO access key
  MINIO_SECRET_KEY     MinIO secret key
`)
}

// Check for help flag
if (args.includes('--help') || args.includes('-h')) {
  showHelp()
  process.exit(0)
}

// Run the script
const extractor = new ExifMetadataExtractor()
extractor.run().catch(console.error)
