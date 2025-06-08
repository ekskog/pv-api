// Upload Service - Handles file uploads with HEIC processing
const HeicProcessor = require('../heic-processor');

class UploadService {
  constructor(minioClient) {
    this.minioClient = minioClient;
    this.heicProcessor = new HeicProcessor();
  }

  /**
   * Process and upload a single file
   * @param {Object} file - Multer file object
   * @param {string} bucketName - MinIO bucket name
   * @param {string} folderPath - Upload folder path
   * @returns {Array} Upload results
   */
  async processAndUploadFile(file, bucketName, folderPath = '') {
    console.log(`\n🔄 UPLOAD SERVICE: Starting file processing for ${file.originalname}`);
    console.log(`📁 Bucket: ${bucketName}, Folder: ${folderPath || 'root'}`);
    console.log(`📏 File size: ${file.size} bytes, MIME: ${file.mimetype}`);
    
    const uploadResults = [];
    const isHeic = HeicProcessor.isHeicFile(file.originalname);
    const isImage = this.isImageFile(file.originalname);
    
    console.log(`🔍 File type detection:`);
    console.log(`   - HEIC file: ${isHeic}`);
    console.log(`   - Image file: ${isImage}`);
    
    try {
      if (isHeic) {
        console.log(`🎯 Processing as HEIC file`);
        // Process HEIC files (convert to JPEG, then to AVIF)
        return await this.processHeicFile(file, bucketName, folderPath);
      } else if (isImage) {
        console.log(`🎯 Processing as regular image file`);
        // Process regular image files (convert to AVIF)
        return await this.processImageFile(file, bucketName, folderPath);
      } else {
        console.log(`🎯 Processing as non-image file`);
        // Upload non-image files as-is
        return await this.uploadRegularFile(file, bucketName, folderPath);
      }
    } catch (error) {
      console.error(`❌ UPLOAD SERVICE ERROR for ${file.originalname}:`, error);
      throw error;
    }
  }

  /**
   * Process regular image file - convert to AVIF variants
   */
  async processImageFile(file, bucketName, folderPath) {
    console.log(`\n🖼️  PROCESS IMAGE: Starting AVIF conversion for ${file.originalname}`);
    
    const uploadResults = [];
    const sharp = require('sharp');

    try {
      console.log(`📊 Extracting metadata...`);
      // Extract EXIF metadata before processing
      const image = sharp(file.buffer);
      const metadata = await image.metadata();
      const exifData = metadata.exif || null;
      
      console.log(`📋 Metadata extracted:`);
      console.log(`   - Format: ${metadata.format}`);
      console.log(`   - Dimensions: ${metadata.width}x${metadata.height}`);
      console.log(`   - EXIF data: ${exifData ? 'Present' : 'None'}`);

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
      console.log(`🏷️  Base filename: ${baseName}`);

      // Process each variant
      for (const variant of variants) {
        console.log(`\n🔧 Processing ${variant.name} variant (${variant.quality}% quality)`);
        
        let processedBuffer;
        
        if (variant.name === 'full') {
          console.log(`   - Creating full-size AVIF (original dimensions)`);
          // For full-size, just convert format while preserving EXIF
          let sharpImage = image.clone();
          if (exifData) {
            console.log(`   - Preserving EXIF metadata`);
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

        console.log(`✅ ${variant.name} variant created:`);
        console.log(`   - Filename: ${variantData.filename}`);
        console.log(`   - Size: ${variantData.size} bytes (${Math.round((variantData.size / file.size) * 100)}% of original)`);
        console.log(`   - MIME type: ${variantData.mimetype}`);

        // Upload variant
        const variantObjectName = folderPath 
          ? `${folderPath.replace(/\/$/, '')}/${variantData.filename}`
          : variantData.filename;

        console.log(`📤 Uploading ${variant.name} variant to: ${variantObjectName}`);
        console.log(`🔄 MinIO upload starting...`);
        console.log(`   - Bucket: ${bucketName}`);
        console.log(`   - Object Name: ${variantObjectName}`);
        console.log(`   - Buffer Size: ${variantData.size} bytes`);
        console.log(`   - Content-Type: ${variantData.mimetype}`);

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

        console.log(`🎉 ✅ MINIO UPLOAD SUCCESSFUL!`);
        console.log(`   - File: ${variantObjectName}`);
        console.log(`   - ETag: ${uploadInfo.etag}`);
        console.log(`   - Version ID: ${uploadInfo.versionId || 'N/A'}`);
        console.log(`   - Bucket: ${bucketName}`);
        console.log(`   - Size Stored: ${variantData.size} bytes`);
        console.log(`   - Format: AVIF (converted from ${metadata.format || 'unknown'})`);
        console.log(`🌟 FILE NOW AVAILABLE IN MINIO STORAGE! 🌟`);

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

      console.log(`\n🎉 IMAGE PROCESSING COMPLETE for ${file.originalname}:`);
      console.log(`   - AVIF file created: ${uploadResults.length}`);
      
      return uploadResults;

    } catch (imageError) {
      console.error(`❌ IMAGE PROCESSING FAILED for ${file.originalname}:`, imageError);
      console.log(`🔄 Falling back to regular file upload...`);
      // Fallback: upload original file if processing fails
      return await this.uploadRegularFile(file, bucketName, folderPath);
    }
  }

  /**
   * Process HEIC file - convert and upload variants
   */
  async processHeicFile(file, bucketName, folderPath) {
    console.log(`\n📸 PROCESS HEIC: Starting HEIC processing for ${file.originalname}`);
    
    const uploadResults = [];

    try {
      console.log(`🔧 Calling HEIC processor...`);
      // Process HEIC file to create variants (just thumbnail now)
      const variants = await this.heicProcessor.processHeicFile(file.buffer, file.originalname);
      
      console.log(`📊 HEIC processor returned ${Object.keys(variants).length} variants:`, Object.keys(variants));
      
      // Upload all variants (thumbnail)
      for (const [variantName, variantData] of Object.entries(variants)) {
        console.log(`\n📤 Uploading HEIC variant: ${variantName}`);
        console.log(`   - Filename: ${variantData.filename}`);
        console.log(`   - Size: ${variantData.size} bytes`);
        console.log(`   - MIME type: ${variantData.mimetype}`);
        
        const variantObjectName = folderPath 
          ? `${folderPath.replace(/\/$/, '')}/${variantData.filename}`
          : variantData.filename;

        console.log(`🔄 MinIO upload starting for HEIC variant...`);
        console.log(`   - Bucket: ${bucketName}`);
        console.log(`   - Object Name: ${variantObjectName}`);
        console.log(`   - Buffer Size: ${variantData.size} bytes`);

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

        console.log(`🎉 ✅ MINIO UPLOAD SUCCESSFUL FOR HEIC VARIANT!`);
        console.log(`   - File: ${variantObjectName}`);
        console.log(`   - ETag: ${uploadInfo.etag}`);
        console.log(`   - Version ID: ${uploadInfo.versionId || 'N/A'}`);
        console.log(`   - Bucket: ${bucketName}`);
        console.log(`   - Size Stored: ${variantData.size} bytes`);
        console.log(`🌟 HEIC VARIANT NOW AVAILABLE IN MINIO STORAGE! 🌟`);

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

      console.log(`\n🎉 HEIC PROCESSING COMPLETE for ${file.originalname}:`);
      console.log(`   - AVIF variants created: ${uploadResults.filter(r => r.variant).length}`);
      
      return uploadResults;

    } catch (heicError) {
      console.error(`❌ HEIC PROCESSING FAILED for ${file.originalname}:`, heicError);
      console.log(`🔄 Falling back to original HEIC upload...`);
      // Fallback: upload original HEIC file with error metadata
      return await this.uploadOriginalHeicAsFallback(file, bucketName, folderPath);
    }
  }

  /**
   * Upload regular (non-HEIC) file
   */
  async uploadRegularFile(file, bucketName, folderPath) {
    console.log(`\n📄 UPLOAD REGULAR: Uploading non-image file ${file.originalname}`);
    
    const objectName = folderPath 
      ? `${folderPath.replace(/\/$/, '')}/${file.originalname}`
      : file.originalname;

    console.log(`📤 Uploading to: ${objectName}`);
    console.log(`📏 Size: ${file.size} bytes, MIME: ${file.mimetype}`);

    console.log(`🔄 MinIO upload starting for regular file...`);
    console.log(`   - Bucket: ${bucketName}`);
    console.log(`   - Object Name: ${objectName}`);
    console.log(`   - Buffer Size: ${file.size} bytes`);

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

    console.log(`🎉 ✅ MINIO UPLOAD SUCCESSFUL FOR REGULAR FILE!`);
    console.log(`   - File: ${objectName}`);
    console.log(`   - ETag: ${uploadInfo.etag}`);
    console.log(`   - Version ID: ${uploadInfo.versionId || 'N/A'}`);
    console.log(`   - Bucket: ${bucketName}`);
    console.log(`   - Size Stored: ${file.size} bytes`);
    console.log(`🌟 REGULAR FILE NOW AVAILABLE IN MINIO STORAGE! 🌟`);

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
    console.log(`\n⚠️  HEIC FALLBACK: Uploading original HEIC due to processing failure`);
    
    const objectName = folderPath 
      ? `${folderPath.replace(/\/$/, '')}/${file.originalname}`
      : file.originalname;

    console.log(`📤 Fallback upload to: ${objectName}`);

    console.log(`🔄 MinIO fallback upload starting for HEIC...`);
    console.log(`   - Bucket: ${bucketName}`);
    console.log(`   - Object Name: ${objectName}`);
    console.log(`   - Buffer Size: ${file.size} bytes`);

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

    console.log(`🎉 ✅ MINIO FALLBACK UPLOAD SUCCESSFUL!`);
    console.log(`   - File: ${objectName}`);
    console.log(`   - ETag: ${uploadInfo.etag}`);
    console.log(`   - Version ID: ${uploadInfo.versionId || 'N/A'}`);
    console.log(`   - Bucket: ${bucketName}`);
    console.log(`   - Size Stored: ${file.size} bytes`);
    console.log(`   - Note: Original HEIC (processing failed)`);
    console.log(`🌟 HEIC FALLBACK FILE NOW AVAILABLE IN MINIO STORAGE! 🌟`);

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
    console.log(`🔍 Image file check for ${filename}: ${isImage} (pattern: ${imageExtensions})`);
    return isImage;
  }
}

module.exports = UploadService;
