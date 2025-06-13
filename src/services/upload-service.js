// Upload Service - Handles file uploads with HEIC processing
const HeicProcessor = require('./heic-processor');
const AvifConverterService = require('./avif-converter-service');

class UploadService {
  constructor(minioClient) {
    this.minioClient = minioClient;
    this.heicProcessor = new HeicProcessor(); // Keep for now, will remove later
    this.avifConverter = new AvifConverterService(); // STEP 3: Add microservice
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
    const memBefore = process.memoryUsage();
    console.log(`[UPLOAD] Processing file: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)}MB, ${file.mimetype})`)
    console.log(`[UPLOAD] Memory before processing: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)}MB heap, ${(memBefore.rss / 1024 / 1024).toFixed(2)}MB RSS`)
    
    const uploadResults = [];
    const isHeic = HeicProcessor.isHeicFile(file.originalname);
    const isImage = UploadService.isImageFile(file.originalname);
    
    console.log(`[UPLOAD] File type detection - HEIC: ${isHeic}, Image: ${isImage}`)
    
    try {
      // Add overall timeout for file processing
      const processingPromise = (async () => {
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
      })();

      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('File processing timeout (5 minutes)')), 300000) // 5 minutes total
      );

      return await Promise.race([processingPromise, timeoutPromise]);
    } catch (error) {
      console.error(`[UPLOAD] Error processing file ${file.originalname}:`, error.message)
      
      // If it's a timeout or processing error, try fallback upload
      if (error.message.includes('timeout') || error.message.includes('processing')) {
        console.log(`[UPLOAD] Attempting fallback upload for: ${file.originalname}`)
        try {
          return await this.uploadRegularFile(file, bucketName, folderPath);
        } catch (fallbackError) {
          console.error(`[UPLOAD] Fallback upload also failed for ${file.originalname}:`, fallbackError.message)
          throw error; // throw original error
        }
      }
      
      throw error;
    } finally {
      // Log memory usage after processing
      const memAfter = process.memoryUsage();
      console.log(`[UPLOAD] Memory after processing: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)}MB heap, ${(memAfter.rss / 1024 / 1024).toFixed(2)}MB RSS`)
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        const memAfterGC = process.memoryUsage();
        console.log(`[UPLOAD] Memory after GC: ${(memAfterGC.heapUsed / 1024 / 1024).toFixed(2)}MB heap, ${(memAfterGC.rss / 1024 / 1024).toFixed(2)}MB RSS`)
      }
    }
  }  /**
   * Process regular image file - convert to AVIF variants
   */
  async processImageFile(file, bucketName, folderPath) {
    const imageTimer = `Image-processing-${file.originalname}`;
    console.time(imageTimer);
    console.log(`[IMAGE_PROCESS] Starting image processing for: ${file.originalname}`)
    
    // Check file size limit to prevent memory issues
    const maxSizeMB = 100; // 100MB limit
    const fileSizeMB = file.size / 1024 / 1024;
    if (fileSizeMB > maxSizeMB) {
      console.error(`[IMAGE_PROCESS] File too large: ${file.originalname} (${fileSizeMB.toFixed(2)}MB > ${maxSizeMB}MB)`)
      throw new Error(`File too large: ${fileSizeMB.toFixed(2)}MB. Maximum allowed: ${maxSizeMB}MB`);
    }
    
    // Overall timeout for entire image processing (5 minutes)
    const overallTimeoutMs = 5 * 60 * 1000;
    console.log(`[IMAGE_PROCESS] Setting overall timeout of ${overallTimeoutMs / 1000}s for image processing`)

    const processImagePromise = this._processImageInternal(file, bucketName, folderPath);
    const overallTimeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Image processing timeout after ${overallTimeoutMs / 1000}s`));
      }, overallTimeoutMs);
    });

    try {
      return await Promise.race([processImagePromise, overallTimeoutPromise]);
    } catch (error) {
      console.timeEnd(imageTimer);
      console.error(`[IMAGE_PROCESS] Image processing failed for ${file.originalname}:`, error.message);
      console.log(`[IMAGE_PROCESS] Falling back to regular file upload for: ${file.originalname}`)
      // Fallback: upload original file if processing fails
      return await this.uploadRegularFile(file, bucketName, folderPath);
    }
  }

  /**
   * Internal image processing method (separated for timeout handling)
   */
  async _processImageInternal(file, bucketName, folderPath) {
    const uploadResults = [];
    const sharp = require('sharp');

    try {
      // Extract EXIF metadata before processing
      const metadataTimer = `Metadata-${file.originalname}`;
      console.time(metadataTimer);
      console.log(`[IMAGE_PROCESS] Extracting metadata from: ${file.originalname}`)
      const image = sharp(file.buffer);
      const metadata = await image.metadata();
      const exifData = metadata.exif || null;
      console.timeEnd(metadataTimer);
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

      // Process each variant with timeout protection
      for (const variant of variants) {
        const variantTimer = `${variant.name}-variant-${file.originalname}`;
        console.time(variantTimer);
        console.log(`[IMAGE_PROCESS] Processing variant: ${variant.name} (${variant.width}x${variant.height}, quality: ${variant.quality})`)
        let processedBuffer;

        try {
          // Set timeout based on variant type
          const timeoutMs = variant.name === 'full' ? 3 * 60 * 1000 : 1 * 60 * 1000; // 3min full, 1min thumbnail
          console.log(`[IMAGE_PROCESS] Setting ${timeoutMs / 1000}s timeout for ${variant.name} variant conversion`)

          const conversionPromise = new Promise(async (resolve, reject) => {
            try {
              if (variant.name === 'full') {
                // For full-size, just convert format while preserving EXIF
                console.log(`[IMAGE_PROCESS] Converting full-size image to AVIF with quality ${variant.quality}`)
                console.log(`[IMAGE_PROCESS] Input: ${file.originalname} (${file.mimetype}) - ${(file.size / 1024 / 1024).toFixed(2)}MB`)
                console.log(`[IMAGE_PROCESS] Sharp metadata: ${JSON.stringify({ 
                  format: metadata.format, 
                  width: metadata.width, 
                  height: metadata.height,
                  channels: metadata.channels,
                  density: metadata.density 
                })}`)
                
                let sharpImage = image.clone()
                  .rotate(); // Auto-rotate based on EXIF orientation data
                
                console.log(`[IMAGE_PROCESS] Created Sharp pipeline for full-size variant`)
                
                if (exifData) {
                  // Preserve EXIF data
                  console.log(`[IMAGE_PROCESS] Preserving EXIF data for full-size variant`)
                  sharpImage = sharpImage.withMetadata();
                } else {
                  console.log(`[IMAGE_PROCESS] No EXIF data to preserve`)
                }
                
                console.log(`[IMAGE_PROCESS] Starting HEIF/AVIF conversion with AV1 compression...`)
                const conversionStart = Date.now()
                const memBefore = process.memoryUsage()
                console.log(`[IMAGE_PROCESS] Memory before conversion: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)}MB heap, ${(memBefore.rss / 1024 / 1024).toFixed(2)}MB RSS`)
                
                const buffer = await sharpImage
                  .heif({ quality: variant.quality, compression: 'av1' })
                  .toBuffer();
                
                const conversionTime = Date.now() - conversionStart
                const memAfter = process.memoryUsage()
                console.log(`[IMAGE_PROCESS] HEIF/AVIF conversion completed in ${conversionTime}ms`)
                console.log(`[IMAGE_PROCESS] Memory after conversion: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)}MB heap, ${(memAfter.rss / 1024 / 1024).toFixed(2)}MB RSS`)
                console.log(`[IMAGE_PROCESS] Output buffer size: ${(buffer.length / 1024).toFixed(2)}KB`)
                
                resolve(buffer);
              } else if (variant.name === 'thumbnail') {
                // For thumbnail, resize and convert
                console.log(`[IMAGE_PROCESS] Creating thumbnail: ${variant.width}x${variant.height}`)
                console.log(`[IMAGE_PROCESS] Input: ${file.originalname} (${file.mimetype}) - ${(file.size / 1024 / 1024).toFixed(2)}MB`)
                console.log(`[IMAGE_PROCESS] Starting resize operation...`)
                
                const resizeStart = Date.now()
                const resizedImage = image.clone()
                  .rotate() // Auto-rotate based on EXIF orientation data
                  .resize(variant.width, variant.height, { 
                    fit: 'cover', 
                    position: 'center' 
                  })
                
                const resizeTime = Date.now() - resizeStart
                console.log(`[IMAGE_PROCESS] Resize completed in ${resizeTime}ms`)
                console.log(`[IMAGE_PROCESS] Starting thumbnail HEIF/AVIF conversion...`)
                
                const thumbConversionStart = Date.now()
                const buffer = await resizedImage
                  .heif({ quality: variant.quality, compression: 'av1' })
                  .toBuffer();
                
                const thumbConversionTime = Date.now() - thumbConversionStart
                console.log(`[IMAGE_PROCESS] Thumbnail HEIF/AVIF conversion completed in ${thumbConversionTime}ms`)
                console.log(`[IMAGE_PROCESS] Thumbnail output buffer size: ${(buffer.length / 1024).toFixed(2)}KB`)
                
                resolve(buffer);
              }
            } catch (conversionError) {
              reject(conversionError);
            }
          });

          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error(`${variant.name} variant conversion timeout after ${timeoutMs / 1000}s`));
            }, timeoutMs);
          });

          // Race between conversion and timeout
          processedBuffer = await Promise.race([conversionPromise, timeoutPromise]);
          console.log(`[IMAGE_PROCESS] ${variant.name} variant conversion completed successfully`)
          
        } catch (variantError) {
          console.timeEnd(variantTimer);
          console.error(`[IMAGE_PROCESS] ${variant.name} variant processing failed for ${file.originalname}:`, variantError.message);
          
          // Skip this variant and continue with others
          console.log(`[IMAGE_PROCESS] Skipping ${variant.name} variant due to processing error`)
          continue;
        }
        
        console.timeEnd(variantTimer);

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

        // Check memory usage before upload
        const memBeforeUpload = process.memoryUsage();
        console.log(`[IMAGE_PROCESS] Memory before upload: ${(memBeforeUpload.heapUsed / 1024 / 1024).toFixed(2)}MB heap`)

        // Upload variant with timeout protection
        const variantObjectName = folderPath 
          ? `${folderPath.replace(/\/$/, '')}/${variantData.filename}`
          : variantData.filename;

        const minioUploadTimer = `MinIO-upload-${variant.name}-${file.originalname}`;
        console.time(minioUploadTimer);
        console.log(`[IMAGE_PROCESS] Uploading variant to MinIO: ${variantObjectName}`)
        
        try {
          const uploadTimeoutMs = 2 * 60 * 1000; // 2 minute timeout for upload
          const uploadPromise = this.minioClient.putObject(
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

          const uploadTimeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error(`MinIO upload timeout after ${uploadTimeoutMs / 1000}s`));
            }, uploadTimeoutMs);
          });

          const uploadInfo = await Promise.race([uploadPromise, uploadTimeoutPromise]);
          console.timeEnd(minioUploadTimer);
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

        } catch (uploadError) {
          console.timeEnd(minioUploadTimer);
          console.error(`[IMAGE_PROCESS] Upload failed for ${variant.name} variant of ${file.originalname}:`, uploadError.message);
          console.log(`[IMAGE_PROCESS] Skipping ${variant.name} variant due to upload error`)
          continue;
        }

        // Clear the processed buffer from memory
        processedBuffer = null;
        
        // Trigger garbage collection if available
        if (global.gc) {
          global.gc();
          const memAfterGC = process.memoryUsage();
          console.log(`[IMAGE_PROCESS] Memory after ${variant.name} variant and GC: ${(memAfterGC.heapUsed / 1024 / 1024).toFixed(2)}MB heap`)
        }
      }

      // Check if we have any successful uploads
      if (uploadResults.length === 0) {
        console.warn(`[IMAGE_PROCESS] No variants were successfully processed for: ${file.originalname}`)
        throw new Error('No variants were successfully processed');
      }
      
      console.log(`[IMAGE_PROCESS] Image processing completed for: ${file.originalname} (${uploadResults.length} variants created)`)
      return uploadResults;

    } catch (error) {
      console.error(`[IMAGE_PROCESS] Internal processing error for ${file.originalname}:`, error.message);
      throw error; // Re-throw to be handled by the outer timeout wrapper
    }
  }

  /**
   * Process HEIC file - convert using microservice and upload variants
   */
  async processHeicFile(file, bucketName, folderPath) {
    const uploadTimer = `HEIC-upload-${file.originalname}`;
    console.time(uploadTimer);
    console.log(`[HEIC_PROCESS] Starting HEIC processing for: ${file.originalname} using microservice`)
    const uploadResults = [];

    try {
      // STEP 3: Use microservice for conversion instead of internal processing
      console.log(`[HEIC_PROCESS] Converting HEIC file using avif-converter microservice: ${file.originalname}`)
      
      // Check if microservice is available
      const isAvailable = await this.avifConverter.isAvailable();
      if (!isAvailable) {
        throw new Error('AVIF converter microservice is not available');
      }
      
      // Convert using microservice
      const conversionResult = await this.avifConverter.convertImage(
        file.buffer, 
        file.originalname, 
        file.mimetype
      );
      
      if (!conversionResult.success) {
        throw new Error(`Microservice conversion failed: ${conversionResult.error}`);
      }
      
      console.log(`[HEIC_PROCESS] Microservice conversion completed, received ${conversionResult.data.files ? conversionResult.data.files.length : 0} files`)
      
      // Process the actual file contents returned from microservice
      const variants = this._processFileContentsFromMicroservice(conversionResult.data.files);
      
      // Upload all variants to MinIO
      for (const [variantName, variantData] of Object.entries(variants)) {
        const minioUploadTimer = `MinIO-upload-${variantName}-${file.originalname}`;
        console.time(minioUploadTimer);
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
            'X-Amz-Meta-Converted-By': 'avif-converter-microservice'
          }
        );
        console.timeEnd(minioUploadTimer);
        console.log(`[HEIC_PROCESS] Successfully uploaded variant: ${variantObjectName} (ETag: ${uploadInfo.etag})`)

        uploadResults.push({
          originalName: file.originalname,
          objectName: variantObjectName,
          variant: variantName,
          size: variantData.size,
          mimetype: variantData.mimetype,
          etag: uploadInfo.etag,
          versionId: uploadInfo.versionId,
          convertedBy: 'avif-converter-microservice'
        });
      }

      console.timeEnd(uploadTimer);
      console.log(`[HEIC_PROCESS] HEIC processing completed using microservice for: ${file.originalname} (${uploadResults.length} variants uploaded)`)
      return uploadResults;

    } catch (error) {
      console.timeEnd(uploadTimer);
      console.error(`[HEIC_PROCESS] HEIC processing failed for ${file.originalname}:`, error.message);
      // STEP 3: No fallback - fail the upload if microservice fails
      throw new Error(`HEIC conversion failed: ${error.message}`);
    }
  }

  /**
   * STEP 4: Process actual file contents returned from microservice
   * @param {Array} microserviceFiles - Array of file objects with base64 content
   * @returns {Object} Variants object suitable for MinIO upload
   */
  _processFileContentsFromMicroservice(microserviceFiles) {
    const variants = {};
    
    for (const fileData of microserviceFiles) {
      try {
        // Decode base64 content back to buffer
        const fileBuffer = Buffer.from(fileData.content, 'base64');
        
        variants[fileData.variant] = {
          buffer: fileBuffer,
          filename: fileData.filename,
          size: fileBuffer.length,
          mimetype: fileData.mimetype || 'image/avif'
        };
        
        console.log(`[UPLOAD] Processed ${fileData.variant} variant: ${fileData.filename} (${(fileBuffer.length / 1024).toFixed(2)}KB)`);
      } catch (error) {
        console.error(`[UPLOAD] Failed to process file ${fileData.filename}:`, error.message);
      }
    }
    
    return variants;
  }

  /**
   * STEP 3: Temporary method - will be removed
   */
  _simulateVariantsFromMicroservice(microserviceData, originalName) {
    // For now, create dummy variants to test the upload flow
    // In reality, we'd read the actual converted files from the microservice
    const dummyAvifBuffer = Buffer.from('dummy avif content');
    const baseName = originalName.replace(/\.[^/.]+$/, '');
    
    return {
      full: {
        buffer: dummyAvifBuffer,
        filename: `${baseName}_full.avif`,
        size: dummyAvifBuffer.length,
        mimetype: 'image/avif'
      },
      thumbnail: {
        buffer: dummyAvifBuffer,
        filename: `${baseName}_thumbnail.avif`,
        size: dummyAvifBuffer.length,
        mimetype: 'image/avif'
      }
    };
  }

  /**
   * Upload regular (non-HEIC) file
   */
  async uploadRegularFile(file, bucketName, folderPath) {
    const uploadTimer = `Regular-upload-${file.originalname}`;
    console.time(uploadTimer);
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
    console.timeEnd(uploadTimer);
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
