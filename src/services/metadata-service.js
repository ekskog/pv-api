const ExifReader = require('exifreader');
const path = require('path');

/**
 * Unified Metadata Service
 * Consolidates EXIF extraction and folder metadata functionality
 * Handles both upload-time processing and batch processing of existing files
 */
class MetadataService {
  constructor(minioClient) {
    this.minioClient = minioClient;
    
    // Image file extensions that can contain EXIF
    this.IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.heic', '.heif'];
  }

  /**
   * Extract EXIF metadata from image buffer (for upload-time processing)
   * This is the main function for the upload workflow
   */
  extractExifFromBuffer(imageBuffer, filename) {
    try {
      const tags = ExifReader.load(imageBuffer);
      
      const exifData = {
        dateTaken: null,
        cameraMake: null,
        cameraModel: null,
        gpsCoordinates: null,
        orientation: null,
        hasExif: false,
        filename: filename,
        fileSize: `${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB`
      };

      // Extract date taken (priority order)
      if (tags.DateTimeOriginal?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTimeOriginal.description);
        exifData.hasExif = true;
      } else if (tags.DateTime?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTime.description);
        exifData.hasExif = true;
      } else if (tags.DateTimeDigitized?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTimeDigitized.description);
        exifData.hasExif = true;
      }

      // Extract camera information
      if (tags.Make?.description) {
        exifData.cameraMake = tags.Make.description.trim();
        exifData.hasExif = true;
      }

      if (tags.Model?.description) {
        exifData.cameraModel = tags.Model.description.trim();
        exifData.hasExif = true;
      }

      // Extract orientation
      if (tags.Orientation?.value) {
        exifData.orientation = tags.Orientation.value;
        exifData.hasExif = true;
      }

      // Extract GPS coordinates with detailed debugging
      console.log(`[GPS DEBUG] Checking GPS tags for ${filename}:`);
      console.log(`[GPS DEBUG] Available GPS tags: ${Object.keys(tags).filter(k => k.startsWith('GPS')).join(', ')}`);
      
      if (tags.GPSLatitude) {
        console.log(`[GPS DEBUG] GPSLatitude found:`, tags.GPSLatitude);
        console.log(`[GPS DEBUG] GPSLatitudeRef:`, tags.GPSLatitudeRef);
      } else {
        console.log(`[GPS DEBUG] No GPSLatitude tag found`);
      }
      
      if (tags.GPSLongitude) {
        console.log(`[GPS DEBUG] GPSLongitude found:`, tags.GPSLongitude);
        console.log(`[GPS DEBUG] GPSLongitudeRef:`, tags.GPSLongitudeRef);
      } else {
        console.log(`[GPS DEBUG] No GPSLongitude tag found`);
      }

      // Extract GPS coordinates
      if (tags.GPSLatitude && tags.GPSLongitude) {
        const lat = this.parseGPSCoordinate(tags.GPSLatitude, tags.GPSLatitudeRef?.description);
        const lon = this.parseGPSCoordinate(tags.GPSLongitude, tags.GPSLongitudeRef?.description);
        if (lat !== null && lon !== null) {
          exifData.gpsCoordinates = `${lat},${lon}`;
          exifData.hasExif = true;
        }
      }

      // Log extracted metadata clearly
      console.log(`[METADATA] ✅ Extracted from ${filename}:`);
      if (exifData.hasExif) {
        if (exifData.dateTaken) console.log(`  📅 Date: ${exifData.dateTaken}`);
        if (exifData.cameraMake) console.log(`  📷 Camera: ${exifData.cameraMake} ${exifData.cameraModel || ''}`);
        if (exifData.gpsCoordinates) console.log(`  📍 GPS: ${exifData.gpsCoordinates}`);
        if (exifData.orientation) console.log(`  🔄 Orientation: ${exifData.orientation}`);
      } else {
        console.log(`  ❌ No EXIF metadata found`);
      }

      return exifData;

    } catch (error) {
      console.warn(`[METADATA] Failed to extract EXIF from ${filename}: ${error.message}`);
      return { 
        hasExif: false, 
        filename: filename,
        fileSize: `${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB`,
        error: error.message 
      };
    }
  }

  /**
   * Extract EXIF data from MinIO object (for batch processing existing files)
   */
  async extractExifFromMinioObject(bucketName, objectName) {
    try {
      // Download image headers (first 64KB should contain EXIF data)
      const imageBuffer = await this.downloadImageHeaders(bucketName, objectName);
      
      const tags = ExifReader.load(imageBuffer);
      
      const exifData = {
        dateTaken: null,
        cameraMake: null,
        cameraModel: null,
        gpsCoordinates: null,
        orientation: null,
        hasExif: false
      };

      // Extract date taken (priority order)
      if (tags.DateTimeOriginal?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTimeOriginal.description);
        exifData.hasExif = true;
      } else if (tags.DateTime?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTime.description);
        exifData.hasExif = true;
      } else if (tags.DateTimeDigitized?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTimeDigitized.description);
        exifData.hasExif = true;
      }

      // Extract camera information
      if (tags.Make?.description) {
        exifData.cameraMake = tags.Make.description.trim();
        exifData.hasExif = true;
      }

      if (tags.Model?.description) {
        exifData.cameraModel = tags.Model.description.trim();
        exifData.hasExif = true;
      }

      // Extract orientation
      if (tags.Orientation?.value) {
        exifData.orientation = tags.Orientation.value;
        exifData.hasExif = true;
      }

      // Extract GPS coordinates
      if (tags.GPSLatitude && tags.GPSLongitude) {
        const lat = this.parseGPSCoordinate(tags.GPSLatitude, tags.GPSLatitudeRef?.description);
        const lon = this.parseGPSCoordinate(tags.GPSLongitude, tags.GPSLongitudeRef?.description);
        if (lat !== null && lon !== null) {
          exifData.gpsCoordinates = `${lat},${lon}`;
          exifData.hasExif = true;
        }
      }

      console.log(`[METADATA] Extracted EXIF from existing file ${objectName}:`, {
        dateTaken: exifData.dateTaken,
        camera: exifData.cameraMake && exifData.cameraModel ? `${exifData.cameraMake} ${exifData.cameraModel}` : null,
        hasGPS: !!exifData.gpsCoordinates,
        orientation: exifData.orientation
      });

      return exifData;

    } catch (error) {
      console.warn(`[METADATA] Failed to extract EXIF from ${objectName}: ${error.message}`);
      return { hasExif: false };
    }
  }

  /**
   * Parse EXIF date string to ISO format
   */
  parseExifDate(exifDateString) {
    try {
      // EXIF date format: "2024:12:25 10:30:45"
      const cleanDate = exifDateString.replace(/(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
      const date = new Date(cleanDate);
      return date.toISOString();
    } catch (error) {
      console.warn(`[METADATA] Failed to parse date: ${exifDateString}`);
      return null;
    }
  }

  /**
   * Parse GPS coordinate from EXIF data
   */
  parseGPSCoordinate(coordinate, ref) {
    try {
      console.log(`[GPS DEBUG] parseGPSCoordinate called with:`, { coordinate, ref });
      
      if (coordinate.description === undefined) {
        console.log(`[GPS DEBUG] No description found in coordinate:`, coordinate);
        return null;
      }
      
      console.log(`[GPS DEBUG] Coordinate description:`, coordinate.description, typeof coordinate.description);
      
      let decimal;
      
      // Check if description is already a decimal number
      if (typeof coordinate.description === 'number') {
        decimal = coordinate.description;
        console.log(`[GPS DEBUG] Using pre-calculated decimal: ${decimal}`);
      } else if (typeof coordinate.description === 'string') {
        // Try to parse as string (format: "degrees,minutes,seconds" or already decimal)
        if (coordinate.description.includes(',')) {
          const coords = coordinate.description.split(',').map(c => parseFloat(c.trim()));
          console.log(`[GPS DEBUG] Parsed coordinate parts:`, coords);
          
          if (coords.length !== 3) {
            console.log(`[GPS DEBUG] Expected 3 coordinate parts, got ${coords.length}`);
            return null;
          }
          
          decimal = coords[0] + coords[1]/60 + coords[2]/3600;
          console.log(`[GPS DEBUG] Calculated decimal from DMS: ${decimal}`);
        } else {
          // Try to parse as already decimal string
          decimal = parseFloat(coordinate.description);
          console.log(`[GPS DEBUG] Parsed decimal from string: ${decimal}`);
        }
      } else {
        console.log(`[GPS DEBUG] Unexpected coordinate description type: ${typeof coordinate.description}`);
        return null;
      }
      
      if (isNaN(decimal)) {
        console.log(`[GPS DEBUG] Invalid decimal value: ${decimal}`);
        return null;
      }
      
      console.log(`[GPS DEBUG] Decimal before applying reference: ${decimal}`);
      
      // Apply hemisphere reference
      if (ref && (ref.includes('S') || ref.includes('W') || ref === 'S' || ref === 'W')) {
        decimal = -decimal;
        console.log(`[GPS DEBUG] Applied ${ref} reference, final decimal: ${decimal}`);
      }
      
      console.log(`[GPS DEBUG] ✅ Final coordinate value: ${decimal}`);
      return decimal;
    } catch (error) {
      console.log(`[GPS DEBUG] Error parsing GPS coordinate:`, error);
      return null;
    }
  }

  /**
   * Update folder metadata JSON file when a new image is uploaded
   * @param {string} bucketName - MinIO bucket name
   * @param {string} objectName - Full path to the uploaded image
   * @param {Object} extractedExifData - Pre-extracted EXIF data
   * @param {Object} uploadInfo - Upload information (etag, size, etc.)
   */
  async updateFolderMetadata(bucketName, objectName, extractedExifData, uploadInfo) {
    try {
      console.log(`[METADATA] Updating folder metadata for: ${objectName}`);
      
      const folderName = this.getFolderName(objectName);
      const jsonFileName = `${folderName}/${folderName}.json`;
      
      // Get object stats for metadata
      const objectStat = await this.minioClient.statObject(bucketName, objectName);
      
      // Create metadata object for this image using pre-extracted EXIF data
      const imageMetadata = {
        sourceImage: objectName,
        extractedAt: new Date().toISOString(),
        fileSize: objectStat.size,
        lastModified: objectStat.lastModified,
        etag: objectStat.etag,
        exif: {
          dateTaken: extractedExifData.dateTaken,
          cameraMake: extractedExifData.cameraMake,
          cameraModel: extractedExifData.cameraModel,
          gpsCoordinates: extractedExifData.gpsCoordinates,
          orientation: extractedExifData.orientation,
          hasExif: extractedExifData.hasExif
        }
      };

      // Check if folder JSON file already exists
      let folderMetadataJson;
      try {
        console.log(`[METADATA] Checking for existing JSON file: ${jsonFileName}`);
        const stream = await this.minioClient.getObject(bucketName, jsonFileName);
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        const jsonContent = Buffer.concat(chunks).toString();
        folderMetadataJson = JSON.parse(jsonContent);
        
        // Add new image to existing array
        folderMetadataJson.images.push(imageMetadata);
        folderMetadataJson.totalImages = folderMetadataJson.images.length;
        folderMetadataJson.lastUpdated = new Date().toISOString();
        
        console.log(`[METADATA] Updated existing JSON file with new image. Total images: ${folderMetadataJson.totalImages}`);
        
      } catch (error) {
        // JSON file doesn't exist, create new one
        console.log(`[METADATA] Creating new JSON file for folder: ${folderName}`);
        folderMetadataJson = {
          folderName: folderName,
          generatedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          migrationTool: 'photovault-metadata-service-v1.0.0',
          totalImages: 1,
          images: [imageMetadata]
        };
      }

      // Upload updated JSON file
      const jsonContent = Buffer.from(JSON.stringify(folderMetadataJson, null, 2));
      await this.minioClient.putObject(
        bucketName,
        jsonFileName,
        jsonContent,
        jsonContent.length,
        {
          'Content-Type': 'application/json',
          'X-Amz-Meta-Folder-Name': folderName,
          'X-Amz-Meta-Image-Count': folderMetadataJson.totalImages.toString(),
          'X-Amz-Meta-Created-By': 'photovault-metadata-service-v1.0.0',
          'X-Amz-Meta-Last-Updated': new Date().toISOString()
        }
      );

      console.log(`[METADATA] Successfully updated folder metadata file: ${jsonFileName} (${folderMetadataJson.totalImages} images)`);
      
      // Log the complete updated JSON structure for debugging
      console.log(`[METADATA] 📄 Updated JSON file content:`, JSON.stringify(folderMetadataJson, null, 2));
      
      return true;

    } catch (error) {
      console.error(`[METADATA] Failed to update folder metadata for ${objectName}:`, error.message);
      // Don't fail the upload if metadata update fails
      return false;
    }
  }

  /**
   * Create MinIO metadata object from EXIF data
   */
  createObjectMetadata(exifData, existingMetadata = {}) {
    const metadata = { ...existingMetadata };

    if (exifData.dateTaken) {
      metadata['X-Amz-Meta-Date-Taken'] = exifData.dateTaken;
    }

    if (exifData.cameraMake) {
      metadata['X-Amz-Meta-Camera-Make'] = exifData.cameraMake;
    }

    if (exifData.cameraModel) {
      metadata['X-Amz-Meta-Camera-Model'] = exifData.cameraModel;
    }

    if (exifData.gpsCoordinates) {
      metadata['X-Amz-Meta-GPS-Coordinates'] = exifData.gpsCoordinates;
    }

    if (exifData.orientation) {
      metadata['X-Amz-Meta-Orientation'] = exifData.orientation.toString();
    }

    metadata['X-Amz-Meta-Has-EXIF'] = exifData.hasExif ? 'true' : 'false';
    metadata['X-Amz-Meta-EXIF-Processed'] = new Date().toISOString();

    return metadata;
  }

  /**
   * Download partial file content (just enough for EXIF)
   */
  async downloadImageHeaders(bucketName, objectName) {
    try {
      // Download first 64KB which should contain EXIF data for most images
      const stream = await this.minioClient.getPartialObject(bucketName, objectName, 0, 65536);
      
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      
      return Buffer.concat(chunks);
    } catch (error) {
      // If partial download fails, download the full file (for smaller images)
      console.warn(`[METADATA] Partial download failed for ${objectName}, downloading full file`);
      const stream = await this.minioClient.getObject(bucketName, objectName);
      
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      
      return Buffer.concat(chunks);
    }
  }

  /**
   * Update object metadata in MinIO using copy operation
   */
  async updateObjectMetadata(bucketName, objectName, newMetadata) {
    try {
      const copyConditions = new this.minioClient.CopyConditions();
      
      await this.minioClient.copyObject(
        bucketName,           // destination bucket
        objectName,           // destination object
        `/${bucketName}/${objectName}`, // source
        copyConditions,       // copy conditions
        newMetadata          // new metadata
      );
      
      console.log(`[METADATA] Successfully updated object metadata for ${objectName}`);
      return true;
    } catch (error) {
      console.error(`[METADATA] Failed to update object metadata for ${objectName}: ${error.message}`);
      return false;
    }
  }

  /**
   * Get folder name from object path
   */
  getFolderName(objectName) {
    const pathParts = objectName.split('/');
    if (pathParts.length > 1) {
      return pathParts[0]; // First part is the folder name
    }
    return 'root'; // Default folder name for root level uploads
  }

  /**
   * Check if file is an image based on extension
   */
  isImageFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return this.IMAGE_EXTENSIONS.includes(ext);
  }

  /**
   * Check if object already has EXIF metadata
   */
  hasExifMetadata(objectStat) {
    const metadata = objectStat.metaData || {};
    return !!(metadata['x-amz-meta-date-taken'] || metadata['x-amz-meta-has-exif']);
  }

  // ===== BATCH PROCESSING METHODS FROM EXTRACT-EXIF-METADATA SCRIPT =====
  
  /**
   * Process a single image file (for batch processing existing files)
   */
  async processExistingImage(bucketName, objectName, objectStat) {
    try {
      console.log(`[METADATA] Processing existing image: ${objectName}...`);

      // Check if already processed
      if (this.hasExifMetadata(objectStat)) {
        console.log(`[METADATA] ${objectName} already has EXIF metadata`);
        return { skipped: true };
      }

      // Extract EXIF data
      const exifData = await this.extractExifFromMinioObject(bucketName, objectName);
      
      // Create new metadata
      const newMetadata = this.createObjectMetadata(exifData, objectStat.metaData);
      
      // Update object metadata
      const success = await this.updateObjectMetadata(bucketName, objectName, newMetadata);
      
      return { success, exifData };

    } catch (error) {
      console.error(`[METADATA] Failed to process existing image ${objectName}: ${error.message}`);
      return { error: error.message };
    }
  }

  /**
   * Get list of image objects to process
   */
  async getImageObjects(bucketName, prefix = '') {
    const objects = [];
    
    console.log(`[METADATA] Scanning bucket '${bucketName}' with prefix '${prefix}'...`);
    
    const stream = this.minioClient.listObjects(bucketName, prefix, true);
    
    for await (const obj of stream) {
      if (this.isImageFile(obj.name)) {
        objects.push(obj);
      }
    }
    
    console.log(`[METADATA] Found ${objects.length} image files`);
    return objects;
  }

  /**
   * Batch process existing images in MinIO
   */
  async batchProcessExistingImages(bucketName, prefix = '', batchSize = 5, dryRun = false) {
    try {
      const objects = await this.getImageObjects(bucketName, prefix);
      
      if (objects.length === 0) {
        console.log('[METADATA] No image files found to process');
        return;
      }

      const stats = {
        totalFiles: objects.length,
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0
      };

      // Process in batches
      const batches = [];
      for (let i = 0; i < objects.length; i += batchSize) {
        batches.push(objects.slice(i, i + batchSize));
      }

      console.log(`[METADATA] Processing ${objects.length} images in ${batches.length} batches of ${batchSize}`);

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        console.log(`\n[METADATA] Processing batch ${i + 1}/${batches.length} (${batch.length} files)`);

        // Process batch in parallel
        const promises = batch.map(async (obj) => {
          try {
            const objectStat = await this.minioClient.statObject(bucketName, obj.name);
            
            if (dryRun) {
              console.log(`[DRY-RUN] Would process ${obj.name}`);
              stats.updated++;
              return;
            }

            const result = await this.processExistingImage(bucketName, obj.name, objectStat);
            
            if (result.skipped) {
              stats.skipped++;
            } else if (result.success) {
              stats.updated++;
            } else {
              stats.errors++;
            }

          } catch (error) {
            console.error(`[METADATA] Failed to get stats for ${obj.name}: ${error.message}`);
            stats.errors++;
          }
          
          stats.processed++;
        });

        await Promise.allSettled(promises);

        // Progress update
        const progress = Math.round((stats.processed / objects.length) * 100);
        console.log(`[METADATA] ${progress}% complete (${stats.processed}/${objects.length})`);
      }

      // Print final stats
      console.log('\n' + '='.repeat(50));
      console.log('METADATA BATCH PROCESSING COMPLETE');
      console.log('='.repeat(50));
      console.log(`Total files found: ${stats.totalFiles}`);
      console.log(`Files processed: ${stats.processed}`);
      console.log(`Files updated: ${stats.updated}`);
      console.log(`Files skipped: ${stats.skipped}`);
      console.log(`Errors: ${stats.errors}`);
      
      if (dryRun) {
        console.log('\n⚠️  DRY RUN MODE - No changes were made');
      }

      return stats;

    } catch (error) {
      console.error(`[METADATA] Batch processing failed: ${error.message}`);
      throw error;
    }
  }
}

module.exports = MetadataService;
