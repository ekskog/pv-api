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
    console.log(`[UPLOAD] Processing file: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)}MB, ${file.mimetype})`)
    
    const uploadResults = [];
    const isHeic = HeicProcessor.isHeicFile(file.originalname);
    const isImage = UploadService.isImageFile(file.originalname);
    
    console.log(`[UPLOAD] File type detection - HEIC: ${isHeic}, Image: ${isImage}`)
    
    try {
      if (isHeic) {
        console.log(`[UPLOAD] Processing HEIC file: ${file.originalname}`)
        return await this.processHeicFile(file, bucketName, folderPath);
      } else if (isImage) {
        console.log(`[UPLOAD] Processing regular image file: ${file.originalname}`)
        return await this.processImageFile(file, bucketName, folderPath);
      } else {
        console.log(`[UPLOAD] Uploading non-image file as-is: ${file.originalname}`)
        return await this.uploadRegularFile(file, bucketName, folderPath);
      }
    } catch (error) {
      console.error(`[UPLOAD] Error processing file ${file.originalname}:`, error.message)
      throw error;
    }
  }

  /**
   * Process regular image file - convert to AVIF variants
   */
  async processImageFile(file, bucketName, folderPath) {
    console.log(`[IMAGE_PROCESS] Starting image processing for: ${file.originalname}`)
    const uploadResults = [];
    const sharp = require('sharp');

    try {
      // Extract EXIF metadata before processing
      console.log(`[IMAGE_PROCESS] Extracting metadata from: ${file.originalname}`)
      const image = sharp(file.buffer);
      const metadata = await image.metadata();
      const exifData = metadata.exif || null;
      console.log(`[IMAGE_PROCESS] Metadata extracted - Format: ${metadata.format}, Dimensions: ${metadata.width}x${metadata.height}, Has EXIF: ${!!exifData}`)

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
      console.log(`[IMAGE_PROCESS] Generating ${variants.length} variants for: ${baseName}`)

      // Process each variant
      for (const variant of variants) {
        console.log(`[IMAGE_PROCESS] Processing variant: ${variant.name} (${variant.width}x${variant.height}, quality: ${variant.quality})`)
        let processedBuffer;
        
        if (variant.name === 'full') {
          // For full-size, just convert format while preserving EXIF
          console.log(`[IMAGE_PROCESS] Converting full-size image to AVIF with quality ${variant.quality}`)
          let sharpImage = image.clone()
            .rotate(); // Auto-rotate based on EXIF orientation data
          if (exifData) {
            // Preserve EXIF data
            console.log(`[IMAGE_PROCESS] Preserving EXIF data for full-size variant`)
            sharpImage = sharpImage.withMetadata();
          }
          processedBuffer = await sharpImage
            .heif({ quality: variant.quality, compression: 'av1' })
            .toBuffer();
        } else if (variant.name === 'thumbnail') {
          // For thumbnail, resize and convert
          console.log(`[IMAGE_PROCESS] Creating thumbnail: ${variant.width}x${variant.height}`)
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

        console.log(`[IMAGE_PROCESS] Generated ${variant.name} variant: ${variantData.filename} (${(variantData.size / 1024).toFixed(2)}KB)`)

        // Upload variant
        const variantObjectName = folderPath 
          ? `${folderPath.replace(/\/$/, '')}/${variantData.filename}`
          : variantData.filename;

        console.log(`[IMAGE_PROCESS] Uploading variant to MinIO: ${variantObjectName}`)
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
        console.log(`[IMAGE_PROCESS] Successfully uploaded variant: ${variantObjectName} (ETag: ${uploadInfo.etag})`)

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

      console.log(`[IMAGE_PROCESS] Image processing completed for: ${file.originalname} (${uploadResults.length} variants created)`)
      return uploadResults;

    } catch (imageError) {
      console.error(`[IMAGE_PROCESS] Image processing failed for ${file.originalname}:`, imageError.message);
      console.log(`[IMAGE_PROCESS] Falling back to regular file upload for: ${file.originalname}`)
      // Fallback: upload original file if processing fails
      return await this.uploadRegularFile(file, bucketName, folderPath);
    }
  }

  /**
   * Process HEIC file - convert and upload variants
   */
  async processHeicFile(file, bucketName, folderPath) {
    console.log(`[HEIC_PROCESS] Starting HEIC processing for: ${file.originalname}`)
    const uploadResults = [];

    try {
      // Process HEIC file to create variants (just thumbnail now)
      console.log(`[HEIC_PROCESS] Converting HEIC file using HeicProcessor: ${file.originalname}`)
      const variants = await this.heicProcessor.processHeicFile(file.buffer, file.originalname);
      console.log(`[HEIC_PROCESS] HEIC processing completed, generated ${Object.keys(variants).length} variants`)
      
      // Upload all variants (thumbnail)
      for (const [variantName, variantData] of Object.entries(variants)) {
        console.log(`[HEIC_PROCESS] Uploading variant: ${variantName} - ${variantData.filename} (${(variantData.size / 1024).toFixed(2)}KB)`)
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
        console.log(`[HEIC_PROCESS] Successfully uploaded variant: ${variantObjectName} (ETag: ${uploadInfo.etag})`)

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

      console.log(`[HEIC_PROCESS] HEIC processing completed for: ${file.originalname} (${uploadResults.length} variants uploaded)`)
      return uploadResults;

    } catch (heicError) {
      console.error(`[HEIC_PROCESS] HEIC processing failed for ${file.originalname}:`, heicError.message);
      console.log(`[HEIC_PROCESS] Falling back to original HEIC file upload for: ${file.originalname}`)
      // Fallback: upload original HEIC file with error metadata
      return await this.uploadOriginalHeicAsFallback(file, bucketName, folderPath);
    }
  }

  /**
   * Upload regular (non-HEIC) file
   */
  async uploadRegularFile(file, bucketName, folderPath) {
    console.log(`[REGULAR_UPLOAD] Uploading regular file: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)}MB)`)
    const objectName = folderPath 
      ? `${folderPath.replace(/\/$/, '')}/${file.originalname}`
      : file.originalname;

    console.log(`[REGULAR_UPLOAD] Target object name: ${objectName}`)
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
    console.log(`[REGULAR_UPLOAD] Successfully uploaded: ${objectName} (ETag: ${uploadInfo.etag})`)

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
    console.log(`[HEIC_FALLBACK] Uploading original HEIC file as fallback: ${file.originalname}`)
    const objectName = folderPath 
      ? `${folderPath.replace(/\/$/, '')}/${file.originalname}`
      : file.originalname;

    console.log(`[HEIC_FALLBACK] Target object name: ${objectName}`)
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
    console.log(`[HEIC_FALLBACK] Successfully uploaded original HEIC: ${objectName} (ETag: ${uploadInfo.etag})`)

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
    console.log(`[BATCH_PROCESS] Starting batch processing of ${files.length} files`)
    const allResults = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`[BATCH_PROCESS] Processing file ${i + 1}/${files.length}: ${file.originalname}`)
      try {
        const results = await this.processAndUploadFile(file, bucketName, folderPath);
        allResults.push(...results);
        console.log(`[BATCH_PROCESS] Successfully processed file ${i + 1}/${files.length}: ${file.originalname} (${results.length} variants)`)
      } catch (error) {
        console.error(`[BATCH_PROCESS] Failed to process file ${i + 1}/${files.length}: ${file.originalname}`, error.message)
        errors.push({
          filename: file.originalname,
          error: error.message
        });
      }
    }

    console.log(`[BATCH_PROCESS] Batch processing completed - Success: ${allResults.length} variants, Errors: ${errors.length} files`)
    return { results: allResults, errors };
  }
}

module.exports = UploadService;
