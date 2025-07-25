const ExifReader = require('exifreader');
const path = require('path');
const debug = require("debug");

// Debug namespaces
const debugMetadata = debug("photovault:metadata");
const debugExif = debug("photovault:metadata:exif");
const debugGps = debug("photovault:metadata:gps");
const debugFolder = debug("photovault:metadata:folder");
const debugBatch = debug("photovault:metadata:batch");

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
    
    debugMetadata(`MetadataService initialized with image extensions: ${this.IMAGE_EXTENSIONS.join(', ')}`);
  }

  /**
   * Extract EXIF metadata from image buffer (for upload-time processing)
   * This is the main function for the upload workflow
   */
  async extractExifFromBuffer(imageBuffer, filename) {
    try {
      debugExif(`Extracting EXIF from buffer for: ${filename} (${imageBuffer.length} bytes)`);
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
        debugExif(`Found DateTimeOriginal: ${tags.DateTimeOriginal.description} -> ${exifData.dateTaken}`);
      } else if (tags.DateTime?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTime.description);
        exifData.hasExif = true;
        debugExif(`Found DateTime: ${tags.DateTime.description} -> ${exifData.dateTaken}`);
      } else if (tags.DateTimeDigitized?.description) {
        exifData.dateTaken = this.parseExifDate(tags.DateTimeDigitized.description);
        exifData.hasExif = true;
        debugExif(`Found DateTimeDigitized: ${tags.DateTimeDigitized.description} -> ${exifData.dateTaken}`);
      }

      // Extract camera information
      if (tags.Make?.description) {
        exifData.cameraMake = tags.Make.description.trim();
        exifData.hasExif = true;
        debugExif(`Found camera make: ${exifData.cameraMake}`);
      }

      if (tags.Model?.description) {
        exifData.cameraModel = tags.Model.description.trim();
        exifData.hasExif = true;
        debugExif(`Found camera model: ${exifData.cameraModel}`);
      }

      // Extract orientation
      if (tags.Orientation?.value) {
        exifData.orientation = tags.Orientation.value;
        exifData.hasExif = true;
        debugExif(`Found orientation: ${exifData.orientation}`);
      }

      // Extract GPS coordinates with detailed debugging
      debugGps(`Checking GPS tags for ${filename}:`);
      debugGps(`Available GPS tags: ${Object.keys(tags).filter(k => k.startsWith('GPS')).join(', ')}`);
      

      // Extract GPS coordinates
      if (tags.GPSLatitude && tags.GPSLongitude) {
        const lat = this.parseGPSCoordinate(tags.GPSLatitude, tags.GPSLatitudeRef?.description);
        const lon = this.parseGPSCoordinate(tags.GPSLongitude, tags.GPSLongitudeRef?.description);
        if (lat !== null && lon !== null) {
          exifData.gpsCoordinates = `${lat},${lon}`;
          exifData.hasExif = true;
          debugGps(`GPS coordinates found: ${exifData.gpsCoordinates}`);
        } else {
          debugGps(`Failed to parse GPS coordinates (lat: ${lat}, lon: ${lon})`);
        }
      } else {
        debugGps(`No GPS coordinates found in EXIF data`);
      }

      debugExif(`Extracted EXIF data for ${filename}:`, exifData);
      return exifData;

    } catch (error) {
      debugExif(`Failed to extract EXIF from ${filename}: ${error.message}`);
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
      debugExif(`Extracting EXIF from MinIO object: ${bucketName}/${objectName}`);
      
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

      debugExif(`EXIF extraction result for ${objectName}:`, exifData);
      return exifData;

    } catch (error) {
      debugExif(`Failed to extract EXIF from ${objectName}: ${error.message}`);
      return { hasExif: false };
    }
  }

  /**
   * Parse EXIF date string to ISO format
   */
  parseExifDate(exifDateString) {
    try {
      debugExif(`Parsing EXIF date: ${exifDateString}`);
      // EXIF date format: "2024:12:25 10:30:45"
      const cleanDate = exifDateString.replace(/(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
      const date = new Date(cleanDate);
      const isoDate = date.toISOString();
      debugExif(`Parsed date: ${exifDateString} -> ${isoDate}`);
      return isoDate;
    } catch (error) {
      debugExif(`Failed to parse date: ${exifDateString} - ${error.message}`);
      return null;
    }
  }

  /**
   * Parse GPS coordinate from EXIF data
   */
  parseGPSCoordinate(coordinate, ref) {
    try {
      debugGps(`Parsing GPS coordinate:`, { coordinate: coordinate.description, ref });
      
      if (coordinate.description === undefined) {
        debugGps(`GPS coordinate description is undefined`);
        return null;
      }
            
      let decimal;
      
      // Check if description is already a decimal number
      if (typeof coordinate.description === 'number') {
        decimal = coordinate.description;
        debugGps(`GPS coordinate is already decimal: ${decimal}`);
      } else if (typeof coordinate.description === 'string') {
        // Try to parse as string (format: "degrees,minutes,seconds" or already decimal)
        if (coordinate.description.includes(',')) {
          const coords = coordinate.description.split(',').map(c => parseFloat(c.trim()));
          
          if (coords.length !== 3) {
            debugGps(`Invalid GPS coordinate format (expected 3 parts, got ${coords.length}): ${coordinate.description}`);
            return null;
          }
          
          decimal = coords[0] + coords[1]/60 + coords[2]/3600;
          debugGps(`Converted DMS to decimal: ${coordinate.description} -> ${decimal}`);
        } else {
          // Try to parse as already decimal string
          decimal = parseFloat(coordinate.description);
          debugGps(`Parsed decimal string: ${coordinate.description} -> ${decimal}`);
        }
      } else {
        debugGps(`Unsupported GPS coordinate type: ${typeof coordinate.description}`);
        return null;
      }
      
      if (isNaN(decimal)) {
        debugGps(`GPS coordinate parsing resulted in NaN: ${coordinate.description}`);
        return null;
      }
      
      
      // Apply hemisphere reference
      if (ref && (ref.includes('S') || ref.includes('W') || ref === 'S' || ref === 'W')) {
        decimal = -decimal;
        debugGps(`Applied hemisphere reference ${ref}: ${decimal}`);
      }
      
      debugGps(`Final GPS coordinate: ${decimal}`);
      return decimal;
    } catch (error) {
      debugGps(`Error parsing GPS coordinate: ${error.message}`);
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
    debugFolder(`Updating folder metadata for ${objectName}...`);
    try {
      
      const folderName = this.getFolderName(objectName);
      
      // Skip metadata update for root-level uploads (no folder structure)
      if (!folderName) {
        debugFolder(`Skipping folder metadata update for root-level upload: ${objectName}`);
        return;
      }
      
      const jsonFileName = `${folderName}/${folderName}.json`;
      debugFolder(`Folder metadata file: ${jsonFileName}`);
      
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
        debugFolder(`Checking for existing metadata file: ${jsonFileName}`);
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
        
        debugFolder(`Updated existing metadata file with new image (total: ${folderMetadataJson.totalImages})`);
        
      } catch (error) {
        // JSON file doesn't exist, create new one
        debugFolder(`Creating new metadata file: ${jsonFileName}`);
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
      
      debugFolder(`Successfully updated folder metadata for ${folderName}`);
      return true;

    } catch (error) {
      debugFolder(`Failed to update folder metadata for ${objectName}: ${error.message}`);
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

    debugMetadata(`Created object metadata:`, metadata);
    return metadata;
  }

  /**
   * Download partial file content (just enough for EXIF)
   */
  async downloadImageHeaders(bucketName, objectName) {
    try {
      debugMetadata(`Downloading image headers for: ${bucketName}/${objectName} (first 64KB)`);
      // Download first 64KB which should contain EXIF data for most images
      const stream = await this.minioClient.getPartialObject(bucketName, objectName, 0, 65536);
      
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      
      const buffer = Buffer.concat(chunks);
      debugMetadata(`Downloaded ${buffer.length} bytes for EXIF extraction`);
      return buffer;
    } catch (error) {
      // If partial download fails, download the full file (for smaller images)
      debugMetadata(`Partial download failed for ${objectName}, downloading full file: ${error.message}`);
      const stream = await this.minioClient.getObject(bucketName, objectName);
      
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      
      const buffer = Buffer.concat(chunks);
      debugMetadata(`Downloaded full file: ${buffer.length} bytes`);
      return buffer;
    }
  }

  /**
   * Update object metadata in MinIO using copy operation
   */
  async updateObjectMetadata(bucketName, objectName, newMetadata) {
    try {
      debugMetadata(`Updating object metadata for: ${bucketName}/${objectName}`);
      const copyConditions = new this.minioClient.CopyConditions();
      
      await this.minioClient.copyObject(
        bucketName,           // destination bucket
        objectName,           // destination object
        `/${bucketName}/${objectName}`, // source
        copyConditions,       // copy conditions
        newMetadata          // new metadata
      );
      
      debugMetadata(`Successfully updated object metadata for ${objectName}`);
      return true;
    } catch (error) {
      debugMetadata(`Failed to update object metadata for ${objectName}: ${error.message}`);
      return false;
    }
  }

  /**
   * Get folder name from object path
   */
  getFolderName(objectName) {
    const pathParts = objectName.split('/');
    if (pathParts.length > 1) {
      const folderName = pathParts[0];
      debugMetadata(`Extracted folder name: ${folderName} from ${objectName}`);
      return folderName; // First part is the folder name
    }
    debugMetadata(`No folder found in path: ${objectName}`);
    return null; // Return null for root level uploads - no folder metadata needed
  }

  /**
   * Check if file is an image based on extension
   */
  isImageFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    const isImage = this.IMAGE_EXTENSIONS.includes(ext);
    debugMetadata(`File ${filename} is ${isImage ? '' : 'not '}an image (extension: ${ext})`);
    return isImage;
  }

  /**
   * Check if object already has EXIF metadata
   */
  hasExifMetadata(objectStat) {
    const metadata = objectStat.metaData || {};
    const hasExif = !!(metadata['x-amz-meta-date-taken'] || metadata['x-amz-meta-has-exif']);
    debugMetadata(`Object has EXIF metadata: ${hasExif}`);
    return hasExif;
  }

  // ===== BATCH PROCESSING METHODS FROM EXTRACT-EXIF-METADATA SCRIPT =====
  
  /**
   * Process a single image file (for batch processing existing files)
   */
  async processExistingImage(bucketName, objectName, objectStat) {
    try {
      debugBatch(`Processing existing image: ${objectName}...`);

      // Check if already processed
      if (this.hasExifMetadata(objectStat)) {
        debugBatch(`${objectName} already has EXIF metadata`);
        return { skipped: true };
      }

      // Extract EXIF data
      const exifData = await this.extractExifFromMinioObject(bucketName, objectName);
      
      // Create new metadata
      const newMetadata = this.createObjectMetadata(exifData, objectStat.metaData);
      
      // Update object metadata
      const success = await this.updateObjectMetadata(bucketName, objectName, newMetadata);
      
      debugBatch(`Processing result for ${objectName}: ${success ? 'success' : 'failed'}`);
      return { success, exifData };

    } catch (error) {
      debugBatch(`Failed to process existing image ${objectName}: ${error.message}`);
      return { error: error.message };
    }
  }

  /**
   * Get list of image objects to process
   */
  async getImageObjects(bucketName, prefix = '') {
    const objects = [];
    
    debugBatch(`Scanning bucket '${bucketName}' with prefix '${prefix}'...`);
    
    const stream = this.minioClient.listObjects(bucketName, prefix, true);
    
    for await (const obj of stream) {
      if (this.isImageFile(obj.name)) {
        objects.push(obj);
      }
    }
    
    debugBatch(`Found ${objects.length} image files`);
    return objects;
  }

  /**
   * Batch process existing images in MinIO
   */
  async batchProcessExistingImages(bucketName, prefix = '', batchSize = 5, dryRun = false) {
    try {
      debugBatch(`Starting batch processing: bucket=${bucketName}, prefix=${prefix}, batchSize=${batchSize}, dryRun=${dryRun}`);
      
      const objects = await this.getImageObjects(bucketName, prefix);
      
      if (objects.length === 0) {
        debugBatch('No image files found to process');
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

      debugBatch(`Processing ${objects.length} images in ${batches.length} batches of ${batchSize}`);

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        debugBatch(`Processing batch ${i + 1}/${batches.length} (${batch.length} files)`);

        // Process batch in parallel
        const promises = batch.map(async (obj) => {
          try {
            const objectStat = await this.minioClient.statObject(bucketName, obj.name);
            
            if (dryRun) {
              debugBatch(`[DRY-RUN] Would process ${obj.name}`);
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
            debugBatch(`Failed to get stats for ${obj.name}: ${error.message}`);
            stats.errors++;
          }
          
          stats.processed++;
        });

        await Promise.allSettled(promises);

        // Progress update
        const progress = Math.round((stats.processed / objects.length) * 100);
        debugBatch(`${progress}% complete (${stats.processed}/${objects.length})`);
      }

      // Print final stats
      debugBatch('='.repeat(50));
      debugBatch('METADATA BATCH PROCESSING COMPLETE');
      debugBatch('='.repeat(50));
      debugBatch(`Total files found: ${stats.totalFiles}`);
      debugBatch(`Files processed: ${stats.processed}`);
      debugBatch(`Files updated: ${stats.updated}`);
      debugBatch(`Files skipped: ${stats.skipped}`);
      debugBatch(`Errors: ${stats.errors}`);
      
      if (dryRun) {
        debugBatch('⚠️  DRY RUN MODE - No changes were made');
      }

      return stats;

    } catch (error) {
      debugBatch(`Batch processing failed: ${error.message}`);
      throw error;
    }
  }
}

module.exports = MetadataService;