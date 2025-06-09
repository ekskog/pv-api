// Upload Service - Handles file uploads with HEIC processing
const HeicProcessor = require('../heic-processor');
const debugService = require('./debug-service');

class UploadService {
  constructor(minioClient) {
    this.minioClient = minioClient;
    this.heicProcessor = new HeicProcessor();
  }

  /**
   * Process and upload a single file
   * @param {Object} file - Multer file object
   * @param {string} bucketName - MinIO bucket  static isImageFile(filename) {
    const imageExtensions = /\.(jpg|jpeg|png|webp|tiff|tif|bmp)$/i;
    const isImage = imageExtensions.test(filename);
    debugService.image.metadata(`Image file check for ${filename}: ${isImage}`)
    return isImage;
  }   * @param {string} folderPath - Upload folder path
   * @returns {Array} Upload results
   */
  async processAndUploadFile(file, bucketName, folderPath = '') {
    const timer = debugService.createTimer('upload', 'processAndUploadFile');
    
    debugService.upload.file(`Starting file processing for ${file.originalname}`, {
      bucket: bucketName,
      folder: folderPath || 'root',
      size: debugService.formatFileSize(file.size),
      mimetype: file.mimetype
    });
    
    const uploadResults = [];
    const isHeic = HeicProcessor.isHeicFile(file.originalname);
    const isImage = this.isImageFile(file.originalname);
    
    debugService.upload.processing(`File type detection`, {
      filename: file.originalname,
      isHeic,
      isImage
    });
    
    try {
      if (isHeic) {
        debugService.upload.file(`Processing as HEIC file: ${file.originalname}`);
        // Process HEIC files (convert to JPEG, then to AVIF)
        return await this.processHeicFile(file, bucketName, folderPath);
      } else if (isImage) {
        debugService.upload.file(`Processing as regular image file: ${file.originalname}`);
        // Process regular image files (convert to AVIF)
        return await this.processImageFile(file, bucketName, folderPath);
      } else {
        debugService.upload.file(`Processing as non-image file: ${file.originalname}`);
        // Upload non-image files as-is
        return await this.uploadRegularFile(file, bucketName, folderPath);
      }
    } catch (error) {
      debugService.upload.error(`Upload service error for ${file.originalname}`, { error: error.message });
      throw error;
    } finally {
      timer.end({ filename: file.originalname });
    }
  }

  /**
   * Process regular image file - convert to AVIF variants
   */
  async processImageFile(file, bucketName, folderPath) {
    const timer = debugService.createTimer('image', 'processImageFile');
    
    debugService.image.conversion(`Starting AVIF conversion for ${file.originalname}`);
    
    const uploadResults = [];
    const sharp = require('sharp');

    try {
      debugService.image.metadata(`Extracting metadata for ${file.originalname}`);
      // Extract EXIF metadata before processing
      const image = sharp(file.buffer);
      const metadata = await image.metadata();
      const exifData = metadata.exif || null;
      
      debugService.image.metadata(`Metadata extracted`, {
        filename: file.originalname,
        format: metadata.format,
        dimensions: `${metadata.width}x${metadata.height}`,
        hasExif: !!exifData
      });

      // Generate only full-size AVIF variant (per user requirements: no thumbnails, no originals)
      const variants = [
        {
          name: 'full',
          width: null, // Keep original dimensions
          height: null,
          quality: 90,
          format: 'avif'
        }
      ];

      const baseName = require('path').parse(file.originalname).name;
      debugService.image.conversion(`Base filename: ${baseName}`);

      // Process each variant
      for (const variant of variants) {
        const variantTimer = debugService.createTimer('image', `${variant.name}Variant`);
        
        debugService.image.avif(`Processing ${variant.name} variant`, {
          filename: file.originalname,
          quality: `${variant.quality}%`
        });
        
        let processedBuffer;
        
        if (variant.name === 'full') {
          debugService.image.avif(`Creating full-size AVIF (original dimensions)`);
          // For full-size, just convert format while preserving EXIF
          let sharpImage = image.clone()
            .rotate(); // Auto-rotate based on EXIF orientation data
          if (exifData) {
            debugService.image.metadata(`Preserving EXIF metadata for ${file.originalname}`);
            // Preserve EXIF data
            sharpImage = sharpImage.withMetadata();
          }
          processedBuffer = await sharpImage
            .heif({ quality: variant.quality, compression: 'av1' })
            .toBuffer();
        }

        const variantData = {
          buffer: processedBuffer,
          filename: `${baseName}_${variant.name}.avif`,
          size: processedBuffer.length,
          mimetype: 'image/avif',
          dimensions: variant.name === 'full' ? {
            width: metadata.width || 'unknown',
            height: metadata.height || 'unknown'
          } : {
            width: variant.width,
            height: variant.height
          }
        };

        debugService.image.avif(`${variant.name} variant created`, {
          filename: variantData.filename,
          size: debugService.formatFileSize(variantData.size),
          compression: `${Math.round((variantData.size / file.size) * 100)}% of original`,
          mimetype: variantData.mimetype
        });

        // Upload variant
        const variantObjectName = folderPath 
          ? `${folderPath.replace(/\/$/, '')}/${variantData.filename}`
          : variantData.filename;

        debugService.upload.minio(`Uploading ${variant.name} variant`, {
          objectName: variantObjectName,
          bucket: bucketName,
          size: debugService.formatFileSize(variantData.size),
          contentType: variantData.mimetype
        });

        const uploadInfo = await this.minioClient.putObject(
          bucketName, 
          variantObjectName, 
          variantData.buffer,
          variantData.size,
          {
            'Content-Type': variantData.mimetype,
            'X-Amz-Meta-Original-Name': file.originalname,
            'X-Amz-Meta-Variant': variant.name,
            'X-Amz-Meta-Upload-Date': new Date().toISOString(),
            'X-Amz-Meta-Dimensions': JSON.stringify(variantData.dimensions),
            'X-Amz-Meta-Original-Format': metadata.format || 'unknown',
            'X-Amz-Meta-Converted-To': 'avif'
          }
        );

        debugService.upload.minio(`MinIO upload successful`, {
          file: variantObjectName,
          etag: uploadInfo.etag,
          versionId: uploadInfo.versionId || 'N/A',
          bucket: bucketName,
          sizeStored: debugService.formatFileSize(variantData.size),
          format: `AVIF (converted from ${metadata.format || 'unknown'})`
        });

        variantTimer.end({ variant: variant.name });

        uploadResults.push({
          originalName: file.originalname,
          objectName: variantObjectName,
          variant: variant.name,
          size: variantData.size,
          mimetype: variantData.mimetype,
          dimensions: variantData.dimensions,
          etag: uploadInfo.etag,
          versionId: uploadInfo.versionId,
          convertedFrom: metadata.format
        });
      }

      debugService.image.conversion(`Image processing complete for ${file.originalname}`, {
        avifFilesCreated: uploadResults.length
      });
      
      timer.end({ success: true, variantsCreated: uploadResults.length });
      return uploadResults;

    } catch (imageError) {
      debugService.image.error(`Image processing failed for ${file.originalname}`, { error: imageError.message });
      debugService.upload.file(`Falling back to regular file upload for ${file.originalname}`);
      // Fallback: upload original file if processing fails
      return await this.uploadRegularFile(file, bucketName, folderPath);
    }
  }

  /**
   * Process HEIC file - convert and upload variants
   */
  async processHeicFile(file, bucketName, folderPath) {
    const timer = debugService.createTimer('image', 'processHeicFile');
    
    debugService.image.heic(`Starting HEIC processing for ${file.originalname}`);
    
    const uploadResults = [];

    try {
      debugService.image.heic(`Calling HEIC processor for ${file.originalname}`);
      // Process HEIC file to create variants (just thumbnail now)
      const variants = await this.heicProcessor.processHeicFile(file.buffer, file.originalname);
      
      debugService.image.heic(`HEIC processor returned ${Object.keys(variants).length} variants`, {
        variants: Object.keys(variants),
        filename: file.originalname
      });
      
      // Upload all variants (thumbnail)
      for (const [variantName, variantData] of Object.entries(variants)) {
        const variantTimer = debugService.createTimer('image', `heicVariant-${variantName}`);
        
        debugService.upload.file(`Uploading HEIC variant: ${variantName}`, {
          filename: variantData.filename,
          size: debugService.formatFileSize(variantData.size),
          mimetype: variantData.mimetype
        });
        
        const variantObjectName = folderPath 
          ? `${folderPath.replace(/\/$/, '')}/${variantData.filename}`
          : variantData.filename;

        debugService.upload.minio(`MinIO upload starting for HEIC variant`, {
          bucket: bucketName,
          objectName: variantObjectName,
          bufferSize: debugService.formatFileSize(variantData.size)
        });

        const uploadInfo = await this.minioClient.putObject(
          bucketName, 
          variantObjectName, 
          variantData.buffer,
          variantData.size,
          {
            'Content-Type': variantData.mimetype,
            'X-Amz-Meta-Original-Name': file.originalname,
            'X-Amz-Meta-Variant': variantName,
            'X-Amz-Meta-Upload-Date': new Date().toISOString(),
            'X-Amz-Meta-Dimensions': JSON.stringify(variantData.dimensions)
          }
        );

        debugService.upload.minio(`MinIO upload successful for HEIC variant`, {
          file: variantObjectName,
          etag: uploadInfo.etag,
          versionId: uploadInfo.versionId || 'N/A',
          bucket: bucketName,
          sizeStored: debugService.formatFileSize(variantData.size)
        });

        variantTimer.end({ variant: variantName });

        uploadResults.push({
          originalName: file.originalname,
          objectName: variantObjectName,
          variant: variantName,
          size: variantData.size,
          mimetype: variantData.mimetype,
          dimensions: variantData.dimensions,
          etag: uploadInfo.etag,
          versionId: uploadInfo.versionId
        });
      }

      debugService.image.heic(`HEIC processing complete for ${file.originalname}`, {
        avifVariantsCreated: uploadResults.filter(r => r.variant).length
      });
      
      timer.end({ success: true, variantsCreated: uploadResults.length });
      return uploadResults;

    } catch (heicError) {
      debugService.image.error(`HEIC processing failed for ${file.originalname}`, { error: heicError.message });
      debugService.upload.file(`Falling back to original HEIC upload for ${file.originalname}`);
      // Fallback: upload original HEIC file with error metadata
      return await this.uploadOriginalHeicAsFallback(file, bucketName, folderPath);
    }
  }

  /**
   * Upload regular (non-HEIC) file
   */
  async uploadRegularFile(file, bucketName, folderPath) {
    const timer = debugService.createTimer('upload', 'uploadRegularFile');
    
    debugService.upload.file(`Uploading non-image file ${file.originalname}`);
    
    const objectName = folderPath 
      ? `${folderPath.replace(/\/$/, '')}/${file.originalname}`
      : file.originalname;

    debugService.upload.file(`Uploading to: ${objectName}`, {
      size: debugService.formatFileSize(file.size),
      mimetype: file.mimetype
    });

    debugService.upload.minio(`MinIO upload starting for regular file`, {
      bucket: bucketName,
      objectName: objectName,
      bufferSize: debugService.formatFileSize(file.size)
    });

    const uploadInfo = await this.minioClient.putObject(
      bucketName, 
      objectName, 
      file.buffer,
      file.size,
      {
        'Content-Type': file.mimetype,
        'X-Amz-Meta-Original-Name': file.originalname,
        'X-Amz-Meta-Upload-Date': new Date().toISOString()
      }
    );

    debugService.upload.minio(`MinIO upload successful for regular file`, {
      file: objectName,
      etag: uploadInfo.etag,
      versionId: uploadInfo.versionId || 'N/A',
      bucket: bucketName,
      sizeStored: debugService.formatFileSize(file.size)
    });

    timer.end({ filename: file.originalname });

    return [{
      originalName: file.originalname,
      objectName: objectName,
      size: file.size,
      mimetype: file.mimetype,
      etag: uploadInfo.etag,
      versionId: uploadInfo.versionId
    }];
  }

  /**
   * Fallback: Upload original HEIC when processing fails
   */
  async uploadOriginalHeicAsFallback(file, bucketName, folderPath) {
    const timer = debugService.createTimer('upload', 'uploadOriginalHeicAsFallback');
    
    debugService.image.heic(`HEIC fallback: Uploading original HEIC due to processing failure`);
    
    const objectName = folderPath 
      ? `${folderPath.replace(/\/$/, '')}/${file.originalname}`
      : file.originalname;

    debugService.upload.file(`Fallback upload to: ${objectName}`);

    debugService.upload.minio(`MinIO fallback upload starting for HEIC`, {
      bucket: bucketName,
      objectName: objectName,
      bufferSize: debugService.formatFileSize(file.size)
    });

    const uploadInfo = await this.minioClient.putObject(
      bucketName, 
      objectName, 
      file.buffer,
      file.size,
      {
        'Content-Type': file.mimetype,
        'X-Amz-Meta-Original-Name': file.originalname,
        'X-Amz-Meta-Upload-Date': new Date().toISOString(),
        'X-Amz-Meta-Heic-Processing': 'failed'
      }
    );

    debugService.upload.minio(`MinIO fallback upload successful`, {
      file: objectName,
      etag: uploadInfo.etag,
      versionId: uploadInfo.versionId || 'N/A',
      bucket: bucketName,
      sizeStored: debugService.formatFileSize(file.size),
      note: 'Original HEIC (processing failed)'
    });

    timer.end({ filename: file.originalname });

    return [{
      originalName: file.originalname,
      objectName: objectName,
      size: file.size,
      mimetype: file.mimetype,
      etag: uploadInfo.etag,
      versionId: uploadInfo.versionId,
      heicProcessingFailed: true
    }];
  }

  /**
   * Process multiple files in batch
   */
  async processMultipleFiles(files, bucketName, folderPath = '') {
    const allResults = [];
    const errors = [];

    for (const file of files) {
      try {
        const results = await this.processAndUploadFile(file, bucketName, folderPath);
        allResults.push(...results);
      } catch (error) {
        errors.push({
          filename: file.originalname,
          error: error.message
        });
      }
    }

    return { results: allResults, errors };
  }

  /**
   * Check if file is an image format that should be converted to AVIF
   * @param {string} filename 
   * @returns {boolean}
   */
  isImageFile(filename) {
    const imageExtensions = /\.(jpg|jpeg|png|webp|tiff|tif|bmp)$/i;
    const isImage = imageExtensions.test(filename);
    debugService.image.metadata(`Image file check for ${filename}: ${isImage}`)
    return isImage;
  }
}

module.exports = UploadService;
