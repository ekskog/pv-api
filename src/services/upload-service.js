// Upload Service - Handles file uploads with AVIF conversion (NO FALLBACKS)
// 
// IMPORTANT: This service enforces strict AVIF conversion requirements:
// - Only successfully converted AVIF files are uploaded to MinIO
// - If AVIF conversion fails, the original file is NOT uploaded
// - Upload failures are properly propagated to the client
// - No fallback mechanisms are implemented by design
const AvifConverterService = require('./avif-converter-service');
const MetadataService = require('./metadata-service');

class UploadService {
  constructor(minioClient) {
    this.minioClient = minioClient;
    this.avifConverter = new AvifConverterService();
    this.metadataService = new MetadataService(minioClient);
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
    console.log(`[UPLOAD SERVICE] Processing file: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)}MB, ${file.mimetype})`)
    console.log(`[UPLOAD SERVICE] Memory before processing: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)}MB heap, ${(memBefore.rss / 1024 / 1024).toFixed(2)}MB RSS`)
    
    
    const uploadResults = [];
    const isHeic = UploadService.isHEICFile(file.originalname);
    const isImage = UploadService.isImageFile(file.originalname);
    const isVideo = UploadService.isVideoFile(file.originalname);
    
    console.log(`[UPLOAD SERVICE] File type detection - HEIC: ${isHeic}, Image: ${isImage}, Video: ${isVideo}`)
    console.log(`[UPLOAD SERVICE] PROCESSING PATH: ${isHeic ? 'HEIC' : isImage ? 'IMAGE' : isVideo ? 'VIDEO' : 'REGULAR'}`)
    
    // Extract EXIF metadata from original file buffer (before conversion)
    let extractedMetadata = null;
    if (isHeic || isImage) {
      console.log(`[UPLOAD SERVICE] Extracting EXIF metadata from original file: ${file.originalname}`);
      extractedMetadata = this.metadataService.extractExifFromBuffer(file.buffer, file.originalname);
    }
    
    try {
      // Add overall timeout for file processing
      const processingPromise = (async () => {
        let uploadResults;
        if (isHeic) {
          console.log(`[UPLOAD SERVICE] Processing HEIC file: ${file.originalname}`)
          uploadResults = await this.processHEICFile(file, bucketName, folderPath);
        } else if (isImage) {
          console.log(`[UPLOAD SERVICE] Processing regular image file: ${file.originalname}`)
          uploadResults = await this.processImageFile(file, bucketName, folderPath);
        } else if (isVideo) {
          console.log(`[UPLOAD SERVICE] Processing video file: ${file.originalname}`)
          uploadResults = await this.processVideoFile(file, bucketName, folderPath);
        } else {
          console.log(`[UPLOAD SERVICE] Uploading non-media file as-is: ${file.originalname}`)
          uploadResults = await this.uploadRegularFile(file, bucketName, folderPath);
        }

        // Update JSON metadata with already extracted data (non-blocking)
        if ((isHeic || isImage) && uploadResults && uploadResults.length > 0 && extractedMetadata) {
          this.updateJsonMetadataAsync(bucketName, uploadResults, extractedMetadata, file.originalname).catch(error => {
            console.error(`[METADATA] Failed to update JSON metadata for ${file.originalname}:`, error.message);
          });
        }

        return uploadResults;
      })();

      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('File processing timeout (5 minutes)')), 300000) // 5 minutes total
      );

      return await Promise.race([processingPromise, timeoutPromise]);
    } catch (error) {
      console.error(`[UPLOAD SERVICE] Error processing file ${file.originalname}:`, error.message)
      
      // NO FALLBACK - If AVIF conversion fails, fail the entire upload
      console.log(`[UPLOAD SERVICE] AVIF conversion failed for ${file.originalname} - NOT uploading original file as per requirements`)
      throw error;
    } finally {
      // Log memory usage after processing
      const memAfter = process.memoryUsage();
      console.log(`[UPLOAD SERVICE] Memory after processing: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)}MB heap, ${(memAfter.rss / 1024 / 1024).toFixed(2)}MB RSS`)
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        const memAfterGC = process.memoryUsage();
        console.log(`[UPLOAD SERVICE] Memory after GC: ${(memAfterGC.heapUsed / 1024 / 1024).toFixed(2)}MB heap, ${(memAfterGC.rss / 1024 / 1024).toFixed(2)}MB RSS`)
      }
    }
  }  /**
   * Process regular image file - convert to AVIF variants using microservice
   */
  async processImageFile(file, bucketName, folderPath) {
    const imageTimer = `Image-processing-${file.originalname}`;
    console.time(imageTimer);
    console.log(`[UPLOAD SERVICE] Starting image processing for: ${file.originalname} using microservice`)
    
    const uploadResults = []; // Initialize uploadResults array
    
    // Check file size limit to prevent memory issues
    const maxSizeMB = 100; // 100MB limit

    try {
      // Use microservice for conversion
      console.log(`[UPLOAD SERVICE] Converting image file using avif-converter microservice: ${file.originalname}`)
      
      // Check if microservice is available
      const isAvailable = await this.avifConverter.isAvailable(file.originalname);
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
      
      console.log(`[UPLOAD SERVICE] Microservice conversion completed, received ${conversionResult.data.files ? conversionResult.data.files.length : 0} files`)
      
      // Process the actual file contents returned from microservice
      const variants = this._processFileContentsFromMicroservice(conversionResult.data.files);
      
      // Upload all variants to MinIO
      for (const [variantName, variantData] of Object.entries(variants)) {
        const minioUploadTimer = `MinIO-upload-${variantName}-${file.originalname}`;
        console.time(minioUploadTimer);
        
        // Log size comparison between original and converted file
        const originalSizeKB = (file.size / 1024).toFixed(2);
        const convertedSizeKB = (variantData.size / 1024).toFixed(2);
        const compressionRatio = ((file.size - variantData.size) / file.size * 100).toFixed(1);
        console.log(`[SIZE_COMPARISON] ${file.originalname}: Original ${originalSizeKB}KB → AVIF ${convertedSizeKB}KB (${compressionRatio}% reduction)`);
        
        console.log(`[UPLOAD SERVICE] Uploading variant: ${variantName} - ${variantData.filename} (${convertedSizeKB}KB)`)
        
        const variantObjectName = folderPath 
          ? `${folderPath.replace(/\/$/, '')}/${variantData.filename}`
          : variantData.filename;

        // DEBUG: Log the object name being sent to MinIO
        console.log(`[UPLOAD SERVICE] MinIO putObject params for variant:`, {
          bucket: bucketName,
          objectName: variantObjectName,
          bufferSize: variantData.buffer ? variantData.buffer.length : 'no buffer',
          sizeParam: variantData.size,
          mimetype: variantData.mimetype
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
            'X-Amz-Meta-Converted-By': 'avif-converter-microservice'
          }
        );
        console.timeEnd(minioUploadTimer);
        console.log(`[UPLOAD SERVICE] Successfully uploaded variant: ${variantObjectName} (ETag: ${uploadInfo.etag})`)

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
      console.log(`[UPLOAD SERVICE] Image processing completed for: ${file.originalname}, uploaded ${uploadResults.length} variants`)
      return uploadResults;
    } catch (error) {
      console.timeEnd(imageTimer);
      console.error(`[UPLOAD SERVICE] Image processing failed for ${file.originalname}:`, error.message);
      console.log(`[UPLOAD SERVICE] AVIF conversion failed - NOT uploading original JPEG as per requirements: ${file.originalname}`)
      // DO NOT fallback to regular upload - fail the entire upload if AVIF conversion fails
      throw error;
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
      const isAvailable = await this.avifConverter.isAvailable(file.originalname);
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
        
        console.log(`[UPLOAD SERVICE] Processed ${fileData.variant} variant: ${fileData.filename} (${(fileBuffer.length / 1024).toFixed(2)}KB)`);
      } catch (error) {
        console.error(`[UPLOAD SERVICE] Failed to process file ${fileData.filename}:`, error.message);
      }
    }
    
    return variants;
  }

  /**
   * Upload regular (non-HEIC) file
   */
  async uploadRegularFile(file, bucketName, folderPath) {
    const uploadTimer = `Regular-upload-${file.originalname}`;
    console.time(uploadTimer);
    console.log(`[REGULAR_UPLOAD] Uploading regular file: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)}MB)`)
    
    // DEBUG: Log all file properties to understand mobile upload differences
    console.log(`[REGULAR_UPLOAD] File object details:`, {
      originalname: file.originalname,
      filename: file.filename,
      fieldname: file.fieldname,
      mimetype: file.mimetype,
      size: file.size,
      bufferLength: file.buffer ? file.buffer.length : 'no buffer',
      encoding: file.encoding
    });
    
    const objectName = folderPath 
      ? `${folderPath.replace(/\/$/, '')}/${file.originalname}`
      : file.originalname;

    console.log(`[REGULAR_UPLOAD] Target object name: "${objectName}"`)
    console.log(`[REGULAR_UPLOAD] MinIO putObject params:`, {
      bucket: bucketName,
      objectName: objectName,
      bufferSize: file.buffer ? file.buffer.length : 'no buffer',
      sizeParam: file.size
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
   * Update JSON metadata file using already extracted EXIF data (async, non-blocking)
   * @param {string} bucketName - MinIO bucket name
   * @param {Array} uploadResults - Array of upload results
   * @param {Object} extractedMetadata - Already extracted EXIF metadata
   * @param {string} originalFilename - Original filename for logging
   */
  async updateJsonMetadataAsync(bucketName, uploadResults, extractedMetadata, originalFilename) {
    try {
      // Only update metadata for full-size images (not thumbnails)
      const fullSizeUploads = uploadResults.filter(result => 
        !result.variant?.includes('thumb')
      );

      if (fullSizeUploads.length === 0) {
        console.log(`[METADATA] No full-size images to update JSON metadata for: ${originalFilename}`);
        return;
      }

      // Update JSON metadata for each full-size upload using already extracted data
      for (const uploadResult of fullSizeUploads) {
        try {
          console.log(`[METADATA] Updating JSON metadata for ${uploadResult.objectName} using pre-extracted EXIF data`);
          
          // Use the metadata service to update the JSON file with extracted data
          await this.metadataService.updateFolderMetadata(
            bucketName,
            uploadResult.objectName,
            extractedMetadata,
            uploadResult
          );
          
          console.log(`[METADATA] Successfully updated JSON metadata for ${uploadResult.objectName}`);
          
        } catch (error) {
          console.error(`[METADATA] Failed to update JSON metadata for ${uploadResult.objectName}:`, error.message);
        }
      }
      
    } catch (error) {
      console.error(`[METADATA] Error in updateJsonMetadataAsync for ${originalFilename}:`, error.message);
    }
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
