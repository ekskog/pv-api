const ExifReader = require('exifreader');

class FolderMetadataService {
  constructor(minioClient) {
    this.minioClient = minioClient;
  }

  /**
   * Update folder metadata JSON file when a new image is uploaded
   * @param {string} bucketName - MinIO bucket name
   * @param {string} objectName - Full path to the uploaded image
   * @param {Buffer} imageBuffer - Image data for EXIF extraction
   * @param {Object} uploadInfo - Upload information (etag, size, etc.)
   * @param {string} originalName - Original filename
   */
  async updateFolderMetadata(bucketName, objectName, imageBuffer, uploadInfo, originalName) {
    try {
      console.log(`[FOLDER_METADATA] Updating folder metadata for: ${objectName}`);
      
      const folderName = this.getFolderName(objectName);
      const jsonFileName = `${folderName}/${folderName}.json`;
      
      // Extract EXIF data from the image
      const exifData = this.extractExifData(imageBuffer, objectName);
      
      // Get object stats for metadata
      const objectStat = await this.minioClient.statObject(bucketName, objectName);
      
      // Create metadata object for this image
      const imageMetadata = {
        sourceImage: objectName,
        extractedAt: new Date().toISOString(),
        fileSize: objectStat.size,
        lastModified: objectStat.lastModified,
        etag: objectStat.etag,
        exif: {
          dateTaken: exifData.dateTaken,
          cameraMake: exifData.cameraMake,
          cameraModel: exifData.cameraModel,
          gpsCoordinates: exifData.gpsCoordinates,
          orientation: exifData.orientation,
          hasExif: exifData.hasExif
        }
      };

      // Check if folder JSON file already exists
      let folderMetadataJson;
      try {
        console.log(`[FOLDER_METADATA] Checking for existing JSON file: ${jsonFileName}`);
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
        
        console.log(`[FOLDER_METADATA] Updated existing JSON file with new image. Total images: ${folderMetadataJson.totalImages}`);
        
      } catch (error) {
        // JSON file doesn't exist, create new one
        console.log(`[FOLDER_METADATA] Creating new JSON file for folder: ${folderName}`);
        folderMetadataJson = {
          folderName: folderName,
          generatedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          migrationTool: 'photovault-upload-service-v1.0.0',
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
          'X-Amz-Meta-Created-By': 'photovault-upload-service-v1.0.0',
          'X-Amz-Meta-Last-Updated': new Date().toISOString()
        }
      );

      console.log(`[FOLDER_METADATA] Successfully updated folder metadata file: ${jsonFileName} (${folderMetadataJson.totalImages} images)`);
      return true;

    } catch (error) {
      console.error(`[FOLDER_METADATA] Failed to update folder metadata for ${objectName}:`, error.message);
      // Don't fail the upload if metadata update fails
      return false;
    }
  }

  /**
   * Update folder metadata JSON file using pre-extracted EXIF data
   * @param {string} bucketName - MinIO bucket name
   * @param {string} objectName - Full path to the uploaded image
   * @param {Object} extractedExifData - Pre-extracted EXIF data
   * @param {Object} uploadInfo - Upload information (etag, size, etc.)
   * @param {string} originalName - Original filename
   */
  async updateFolderMetadataWithExif(bucketName, objectName, extractedExifData, uploadInfo, originalName) {
    try {
      console.log(`[FOLDER_METADATA] Updating folder metadata for: ${objectName} with pre-extracted EXIF`);
      
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
        console.log(`[FOLDER_METADATA] Checking for existing JSON file: ${jsonFileName}`);
        const stream = await this.minioClient.getObject(bucketName, jsonFileName);
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        const jsonContent = Buffer.concat(chunks).toString();
        folderMetadataJson = JSON.parse(jsonContent);
        
        console.log(`[FOLDER_METADATA] Found existing JSON file with ${folderMetadataJson.images?.length || 0} images`);
      } catch (error) {
        // JSON file doesn't exist, create new one
        console.log(`[FOLDER_METADATA] No existing JSON file found, creating new one for folder: ${folderName}`);
        folderMetadataJson = {
          folderName: folderName,
          generatedAt: new Date().toISOString(),
          migrationTool: 'photovault-upload-service-v1.0.0',
          totalImages: 0,
          images: []
        };
      }

      // Check if this image already exists in the metadata (by sourceImage path)
      const existingIndex = folderMetadataJson.images.findIndex(img => img.sourceImage === objectName);
      
      if (existingIndex >= 0) {
        // Update existing entry
        console.log(`[FOLDER_METADATA] Updating existing metadata entry for: ${objectName}`);
        folderMetadataJson.images[existingIndex] = imageMetadata;
      } else {
        // Add new entry
        console.log(`[FOLDER_METADATA] Adding new metadata entry for: ${objectName}`);
        folderMetadataJson.images.push(imageMetadata);
      }

      // Update totals and timestamps
      folderMetadataJson.totalImages = folderMetadataJson.images.length;
      folderMetadataJson.lastUpdated = new Date().toISOString();

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
          'X-Amz-Meta-Updated-By': 'photovault-upload-service-v1.0.0'
        }
      );
      
      console.log(`[FOLDER_METADATA] Successfully updated ${jsonFileName} (${folderMetadataJson.totalImages} images total)`);
      
    } catch (error) {
      console.error(`[FOLDER_METADATA] Failed to update folder metadata for ${objectName}:`, error.message);
      throw error;
    }
  }

  /**
   * Get folder name from object path
   */
  getFolderName(objectName) {
    const parts = objectName.split('/');
    return parts.length > 1 ? parts[0] : 'root';
  }

  /**
   * Extract EXIF data from image buffer
   */
  extractExifData(imageBuffer, filename) {
    try {
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

      console.log(`[FOLDER_METADATA] Extracted EXIF from ${filename}: camera=${exifData.cameraMake} ${exifData.cameraModel}, dateTaken=${exifData.dateTaken}, hasGPS=${!!exifData.gpsCoordinates}`);
      return exifData;

    } catch (error) {
      console.warn(`[FOLDER_METADATA] Failed to extract EXIF from ${filename}: ${error.message}`);
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
      console.warn(`[FOLDER_METADATA] Failed to parse date: ${exifDateString}`);
      return null;
    }
  }

  /**
   * Parse GPS coordinate from EXIF data
   */
  parseGPSCoordinate(coordinate, ref) {
    try {
      if (!coordinate.description) return null;
      
      const coords = coordinate.description.split(',').map(c => parseFloat(c.trim()));
      if (coords.length !== 3) return null;
      
      let decimal = coords[0] + coords[1]/60 + coords[2]/3600;
      
      // Apply hemisphere reference
      if (ref && (ref === 'S' || ref === 'W')) {
        decimal = -decimal;
      }
      
      return decimal;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if a file is a full-size image (not a thumbnail)
   */
  isFullSizeImage(filename) {
    const basename = filename.toLowerCase();
    
    // Skip thumbnail files (common patterns)
    if (basename.includes('thumb') || 
        basename.includes('thumbnail') || 
        basename.includes('_thumb') ||
        basename.includes('-thumb') ||
        basename.endsWith('_t') ||
        basename.endsWith('-t')) {
      return false;
    }
    
    return true;
  }
}

module.exports = FolderMetadataService;
