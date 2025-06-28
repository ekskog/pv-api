// Upload Service - Handles file uploads with HEIC processing
const AvifConverterService = require('./avif-converter-service');

class UploadService {
  constructor(minioClient) {
    this.minioClient = minioClient;
    this.avifConverter = new AvifConverterService();
  }

  /**
   * Check if a file is a HEIC file
   * @param {string} filename - Filename to check
   * @returns {boolean} True if it's a HEIC file
   */
  static isHEICFile(filename) {
    const heicExtensions = /\.(heic|heif)$/i;
    return heicExtensions.test(filename);
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
   * Check if a file is a video file
   * @param {string} filename - Filename to check
   * @returns {boolean} True if it's a video file
   */
  static isVideoFile(filename) {
    const videoExtensions = /\.(mov|mp4|m4v|avi|mkv|webm|flv|wmv|3gp|m2ts|mts)$/i;
    return videoExtensions.test(filename);
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
    const isHeic = UploadService.isHEICFile(file.originalname);
    const isImage = UploadService.isImageFile(file.originalname);
    const isVideo = UploadService.isVideoFile(file.originalname);
    
    console.log(`[UPLOAD] File type detection - HEIC: ${isHeic}, Image: ${isImage}, Video: ${isVideo}`)
    
    try {
      // Add overall timeout for file processing
      const processingPromise = (async () => {
        if (isHeic) {
          console.log(`[UPLOAD] Processing HEIC file: ${file.originalname}`)
          return await this.processHEICFile(file, bucketName, folderPath);
        } else if (isImage) {
          console.log(`[UPLOAD] Processing regular image file: ${file.originalname}`)
          return await this.processImageFile(file, bucketName, folderPath);
        } else if (isVideo) {
          console.log(`[UPLOAD] Processing video file: ${file.originalname}`)
          return await this.processVideoFile(file, bucketName, folderPath);
        } else {
          console.log(`[UPLOAD] Uploading non-media file as-is: ${file.originalname}`)
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
   * Process regular image file - convert to AVIF variants using microservice
   */
  async processImageFile(file, bucketName, folderPath) {
    const imageTimer = `Image-processing-${file.originalname}`;
    console.time(imageTimer);
    console.log(`[IMAGE_PROCESS] Starting image processing for: ${file.originalname} using microservice`)
    
    // Check file size limit to prevent memory issues
    const maxSizeMB = 100; // 100MB limit
    const fileSizeMB = file.size / 1024 / 1024;
    if (fileSizeMB > maxSizeMB) {
      console.error(`[IMAGE_PROCESS] File too large: ${file.originalname} (${fileSizeMB.toFixed(2)}MB > ${maxSizeMB}MB)`)
      throw new Error(`File too large: ${fileSizeMB.toFixed(2)}MB. Maximum allowed: ${maxSizeMB}MB`);
    }
    
    const uploadResults = [];

    try {
      // Use microservice for conversion
      console.log(`[IMAGE_PROCESS] Converting image file using avif-converter microservice: ${file.originalname}`)
      
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
      
      console.log(`[IMAGE_PROCESS] Microservice conversion completed, received ${conversionResult.data.files ? conversionResult.data.files.length : 0} files`)
      
      // Process the actual file contents returned from microservice
      const variants = this._processFileContentsFromMicroservice(conversionResult.data.files);
      
      // Upload all variants to MinIO
      for (const [variantName, variantData] of Object.entries(variants)) {
        const minioUploadTimer = `MinIO-upload-${variantName}-${file.originalname}`;
        console.time(minioUploadTimer);
        console.log(`[IMAGE_PROCESS] Uploading variant: ${variantName} - ${variantData.filename} (${(variantData.size / 1024).toFixed(2)}KB)`)
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
        console.log(`[IMAGE_PROCESS] Successfully uploaded variant: ${variantObjectName} (ETag: ${uploadInfo.etag})`)

        uploadResults.push({
          originalName: file.originalname,
          objectName: variantObjectName,
          variant: variantName,
          size: variantData.size,
          mimetype: variantData.mimetype,
          etag: uploadInfo.etag,
          versionId: uploadInfo.versionId
        });
      }

      console.timeEnd(imageTimer);
      console.log(`[IMAGE_PROCESS] Image processing completed for: ${file.originalname}, uploaded ${uploadResults.length} variants`)
      return uploadResults;
    } catch (error) {
      console.timeEnd(imageTimer);
      console.error(`[IMAGE_PROCESS] Image processing failed for ${file.originalname}:`, error.message);
      console.log(`[IMAGE_PROCESS] Falling back to regular file upload for: ${file.originalname}`)
      // Fallback: upload original file if processing fails
      return await this.uploadRegularFile(file, bucketName, folderPath);
    }
  }

  /**
   * Process Image files - convert using microservice and upload variants
   */
  async processHEICFile(file, bucketName, folderPath) {
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
   * Process video file - upload directly to MinIO without conversion
   * @param {Object} file - Multer file object
   * @param {string} bucketName - MinIO bucket name
   * @param {string} folderPath - Upload folder path
   * @returns {Array} Upload results
   */
  async processVideoFile(file, bucketName, folderPath) {
    const videoTimer = `Video-upload-${file.originalname}`;
    console.time(videoTimer);
    console.log(`[VIDEO_UPLOAD] Processing video file: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)}MB, ${file.mimetype})`)
    
    // Check file size limit for videos (larger than images)
    const maxSizeMB = 2000; // 2GB limit for videos
    const fileSizeMB = file.size / 1024 / 1024;
    if (fileSizeMB > maxSizeMB) {
      console.error(`[VIDEO_UPLOAD] Video file too large: ${file.originalname} (${fileSizeMB.toFixed(2)}MB > ${maxSizeMB}MB)`)
      throw new Error(`Video file too large: ${fileSizeMB.toFixed(2)}MB. Maximum allowed: ${maxSizeMB}MB`);
    }

    try {
      // Create object name with video prefix for organization
      const objectName = folderPath 
        ? `${folderPath.replace(/\/$/, '')}/${file.originalname}`
        : file.originalname;

      console.log(`[VIDEO_UPLOAD] Uploading video to: ${objectName}`)
      
      // Upload directly to MinIO with video-specific metadata
      const uploadInfo = await this.minioClient.putObject(
        bucketName, 
        objectName, 
        file.buffer,
        file.size,
        {
          'Content-Type': file.mimetype || 'video/quicktime', // Default to MOV if no mimetype
          'X-Amz-Meta-Original-Name': file.originalname,
          'X-Amz-Meta-Upload-Date': new Date().toISOString(),
          'X-Amz-Meta-File-Type': 'video',
          'X-Amz-Meta-Source': 'iPhone' // Assuming iPhone source based on user request
        }
      );

      console.timeEnd(videoTimer);
      console.log(`[VIDEO_UPLOAD] Successfully uploaded video: ${objectName} (ETag: ${uploadInfo.etag})`)

      return [{
        originalName: file.originalname,
        objectName: objectName,
        size: file.size,
        mimetype: file.mimetype || 'video/quicktime',
        etag: uploadInfo.etag,
        versionId: uploadInfo.versionId,
        fileType: 'video'
      }];

    } catch (error) {
      console.timeEnd(videoTimer);
      console.error(`[VIDEO_UPLOAD] Video upload failed for ${file.originalname}:`, error.message);
      throw error;
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
