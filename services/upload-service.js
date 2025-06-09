// Upload Service - Handles file uploads with HEIC processing
const HeicProcessor = require('./heic-processor');

class UploadService {
  constructor(minioClient) {
    this.minioClient = minioClient;
    this.heicProcessor = new HeicProcessor();
  }

  /**
   * Check if a file is a regular image file (not HEIC)
   * @param {string} filename - Filename to check
   * @returns {boolean} True if it's a regular image file
   */
  static isImageFile(filename) {
    const imageExtensions = /\.(jpg|jpeg|png|webp|tiff|tif|bmp)$/i;
    return imageExtensions.test(filename);
  }

  /**
   * Process and upload a single file
   * @param {Object} file - Multer file object
   * @param {string} bucketName - MinIO bucket name
   * @param {string} folderPath - Upload folder path
   * @returns {Array} Upload results
   */
  async processAndUploadFile(file, bucketName, folderPath = '') {
    const uploadResults = [];
    const isHeic = HeicProcessor.isHeicFile(file.originalname);
    const isImage = UploadService.isImageFile(file.originalname);
    
    try {
      if (isHeic) {
        // Process HEIC files (convert to JPEG, then to AVIF)
        return await this.processHeicFile(file, bucketName, folderPath);
      } else if (isImage) {
        // Process regular image files (convert to AVIF)
        return await this.processImageFile(file, bucketName, folderPath);
      } else {
        // Upload non-image files as-is
        return await this.uploadRegularFile(file, bucketName, folderPath);
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Process regular image file - convert to AVIF variants
   */
  async processImageFile(file, bucketName, folderPath) {
    const uploadResults = [];
    const sharp = require('sharp');

    try {
      // Extract EXIF metadata before processing
      const image = sharp(file.buffer);
      const metadata = await image.metadata();
      const exifData = metadata.exif || null;

      // Generate full-size AVIF and thumbnail variants
      const variants = [
        {
          name: 'full',
          width: null, // Keep original dimensions
          height: null,
          quality: 90,
          format: 'avif'
        },
        {
          name: 'thumbnail',
          width: 300,
          height: 300,
          quality: 80,
          format: 'avif'
        }
      ];

      const baseName = require('path').parse(file.originalname).name;

      // Process each variant
      for (const variant of variants) {
        let processedBuffer;
        
        if (variant.name === 'full') {
          // For full-size, just convert format while preserving EXIF
          let sharpImage = image.clone()
            .rotate(); // Auto-rotate based on EXIF orientation data
          if (exifData) {
            // Preserve EXIF data
            sharpImage = sharpImage.withMetadata();
          }
          processedBuffer = await sharpImage
            .heif({ quality: variant.quality, compression: 'av1' })
            .toBuffer();
        } else if (variant.name === 'thumbnail') {
          // For thumbnail, resize and convert
          processedBuffer = await image.clone()
            .rotate() // Auto-rotate based on EXIF orientation data
            .resize(variant.width, variant.height, { 
              fit: 'cover', 
              position: 'center' 
            })
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

        // Upload variant
        const variantObjectName = folderPath 
          ? `${folderPath.replace(/\/$/, '')}/${variantData.filename}`
          : variantData.filename;

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

      return uploadResults;

    } catch (imageError) {
      console.error('Image processing failed:', imageError.message);
      // Fallback: upload original file if processing fails
      return await this.uploadRegularFile(file, bucketName, folderPath);
    }
  }

  /**
   * Process HEIC file - convert and upload variants
   */
  async processHeicFile(file, bucketName, folderPath) {
    const uploadResults = [];

    try {
      // Process HEIC file to create variants (just thumbnail now)
      const variants = await this.heicProcessor.processHeicFile(file.buffer, file.originalname);
      
      // Upload all variants (thumbnail)
      for (const [variantName, variantData] of Object.entries(variants)) {
        const variantObjectName = folderPath 
          ? `${folderPath.replace(/\/$/, '')}/${variantData.filename}`
          : variantData.filename;

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

      return uploadResults;

    } catch (heicError) {
      console.error('HEIC processing failed:', heicError.message);
      // Fallback: upload original HEIC file with error metadata
      return await this.uploadOriginalHeicAsFallback(file, bucketName, folderPath);
    }
  }

  /**
   * Upload regular (non-HEIC) file
   */
  async uploadRegularFile(file, bucketName, folderPath) {
    const objectName = folderPath 
      ? `${folderPath.replace(/\/$/, '')}/${file.originalname}`
      : file.originalname;

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
    const objectName = folderPath 
      ? `${folderPath.replace(/\/$/, '')}/${file.originalname}`
      : file.originalname;

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
}

module.exports = UploadService;
