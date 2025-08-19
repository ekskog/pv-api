const debug = require("debug");
const AvifConverterService = require("./avif-converter-service");
const MetadataService = require("./metadata-service");

// Debug namespaces
const debugUpload = debug("photovault:upload");
const debugImage = debug("photovault:upload:image");
const debugVideo = debug("photovault:upload:video");
const debugBatch = debug("photovault:upload:batch");
const debugMetadata = debug("photovault:upload:metadata");
const debugMemory = debug("photovault:upload:memory");
const debugRegular = debug("photovault:upload:regular");

// Upload Service - Handles file uploads with AVIF conversion (NO FALLBACKS)
//
// IMPORTANT: This service enforces strict AVIF conversion requirements:
// - Only successfully converted AVIF files are uploaded to MinIO
// - If AVIF conversion fails, the original file is NOT uploaded
// - Upload failures are properly propagated to the client
// - No fallback mechanisms are implemented by design

class UploadService {
  constructor(minioClient) {
    this.minioClient = minioClient;
    this.avifConverter = new AvifConverterService();
    this.metadataService = new MetadataService(minioClient);
  }

  /**
   * Process and upload a single file
   * @param {Object} file - Multer file object
   * @param {string} bucketName - MinIO bucket name
   * @param {string} folderPath - Upload folder path
   * @returns {Array} Upload results
   */
  async processAndUploadFile(file, bucketName, folderPath = "") {
    let mimetype = file.mimetype;
    let extractedMetadata = null;
    let uploadResult = null;

    try {
      if (mimetype === "image/heic" || mimetype === "image/jpeg") {
       
        // Extract metadata first
        extractedMetadata = await this.metadataService.extractEssentialMetadata(file.buffer, file.originalname);
        debugMetadata(`[upload-service.js LINE 46]: Extracted metadata for ${file.originalname}: ${JSON.stringify(extractedMetadata)}`);

        // Process image file
        await this.processImageFile(file, bucketName, folderPath, mimetype);

        // Update JSON metadata with already extracted data (non-blocking)
        if (uploadResult && extractedMetadata) {
          this.updateJsonMetadataAsync(
            bucketName,
            uploadResult,
            extractedMetadata,
            file.originalname
          ).catch((error) => {
            throw new Error (`Failed to update JSON metadata for ${file.originalname}: ${error.message}`);
          });
        }

        return uploadResult;
      }
    } catch (error) {
      // NO FALLBACK - If AVIF conversion fails, fail the entire upload
      debugUpload(`[upload-service.js LINE 66]: AVIF conversion failed for ${file.originalname} - NOT uploading original file as per requirements`);
      throw error;
    } finally {
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        const memAfterGC = process.memoryUsage();
        debugMemory(
          `[upload-service.js LINE 74]: Memory after GC: ${(
            memAfterGC.heapUsed /
            1024 /
            1024
          ).toFixed(2)}MB heap, ${(memAfterGC.rss / 1024 / 1024).toFixed(
            2
          )}MB RSS`
        );
      }
    }
  }

  /**
   * Process image files (HEIC or JPEG) - convert using microservice and upload variants
   * @param {Object} file - Multer file object
   * @param {string} bucketName - MinIO bucket name
   * @param {string} folderPath - Upload folder path
   * @param {string} mimetype - File mimetype (e.g., 'image/heic', 'image/jpeg')
   * @returns {Array} Upload results
   */
  async processImageFile(file, bucketName, folderPath, mimetype) {
    let uploadResult = null;
    const uploadTimer = `${mimetype}-upload-${file.originalname}`;    
    try {
      // Convert using microservice
      const conversionResult = await this.avifConverter.convertImage(
        file.buffer,
        file.originalname,
        file.mimetype
      );

      // Process the actual file contents returned from microservice
      debugImage(`[upload-service.js LINE 106]: Processing file contents from microservice for ${file.originalname}`);
      const variants = this._processFileContentsFromMicroservice(
        conversionResult.data.files
      );

      // Upload all variants to MinIO
      for (const [variantName, variantData] of Object.entries(variants)) {
        const variantObjectName = folderPath
          ? `${folderPath.replace(/\/$/, "")}/${variantData.filename}`
          : variantData.filename;

        const uploadInfo = await this.minioClient.putObject(
          bucketName,
          variantObjectName,
          variantData.buffer,
          variantData.size,
          {
            "Content-Type": variantData.mimetype,
            "X-Amz-Meta-Original-Name": file.originalname,
            "X-Amz-Meta-Variant": variantName,
            "X-Amz-Meta-Upload-Date": new Date().toISOString(),
            "X-Amz-Meta-Converted-By": "avif-converter-microservice",
          }
        );

        uploadResult = {
          originalName: file.originalname,
          objectName: variantObjectName,
          variant: variantName,
          size: variantData.size,
          mimetype: variantData.mimetype,
          etag: uploadInfo.etag,
          versionId: uploadInfo.versionId,
        };
      }

      debugImage(`[upload-service.js LINE 142]: Image processing completed for ${file.originalname}`);
      return uploadResult;
    } catch (error) {
      debugImage(`[upload-service.js LINE 145]: ${mimetype} processing failed for ${file.originalname}: ${error.message}`);
      throw error;
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
    
    // Check file size limit for videos (larger than images)
    const maxSizeMB = 2000; // 2GB limit for videos
    const fileSizeMB = file.size / 1024 / 1024;
    if (fileSizeMB > maxSizeMB) {
      debugVideo(
        `[upload-service.js LINE 166]: Video file too large: ${file.originalname} (${fileSizeMB.toFixed(2)}MB > ${maxSizeMB}MB)`
      );
      throw new Error(
        `Video file too large: ${fileSizeMB.toFixed(
          2
        )}MB. Maximum allowed: ${maxSizeMB}MB`
      );
    }

    try {
      // Create object name with video prefix for organization
      const objectName = folderPath
        ? `${folderPath.replace(/\/$/, "")}/${file.originalname}`
        : file.originalname;

      debugVideo(`[upload-service.js LINE 181]: Uploading video to MinIO: ${objectName}`);

      // Upload directly to MinIO with video-specific metadata
      const uploadInfo = await this.minioClient.putObject(
        bucketName,
        objectName,
        file.buffer,
        file.size,
        {
          "Content-Type": file.mimetype || "video/quicktime", // Default to MOV if no mimetype
          "X-Amz-Meta-Original-Name": file.originalname,
          "X-Amz-Meta-Upload-Date": new Date().toISOString(),
          "X-Amz-Meta-File-Type": "video",
          "X-Amz-Meta-Source": "iPhone", // Assuming iPhone source based on user request
        }
      );

      console.timeEnd(videoTimer);

      return [
        {
          originalName: file.originalname,
          objectName: objectName,
          size: file.size,
          mimetype: file.mimetype || "video/quicktime",
          etag: uploadInfo.etag,
          versionId: uploadInfo.versionId,
          fileType: "video",
        },
      ];
    } catch (error) {
      console.timeEnd(videoTimer);
      debugVideo(
        `Video upload failed for ${file.originalname}: ${error.message}`
      );
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
        debugImage(`[upload-service.js LINE 230]: Processing variant ${fileData.variant}: ${fileData.filename}`);
        
        // Decode base64 content back to buffer
        const fileBuffer = Buffer.from(fileData.content, "base64");

        variants[fileData.variant] = {
          buffer: fileBuffer,
          filename: fileData.filename,
          size: fileBuffer.length,
          mimetype: fileData.mimetype || "image/avif",
        };

        debugImage(
          `[upload-service.js LINE 243]: Processed ${fileData.variant} variant: ${fileData.filename} (${(fileBuffer.length / 1024).toFixed(2)}KB)`
        );
      } catch (error) {
        debugImage(
          `[upload-service.js LINE 247]: Failed to process file ${fileData.filename}: ${error.message}`
        );
      }
    }

    debugImage(`[upload-service.js LINE 252]: Successfully processed ${Object.keys(variants).length} variants`);
    return variants;
  }

  /**
   * Upload regular (non-HEIC) file
   */
  async uploadRegularFile(file, bucketName, folderPath) {
    const uploadTimer = `Regular-upload-${file.originalname}`;
    console.time(uploadTimer);
    
     const objectName = folderPath
      ? `${folderPath.replace(/\/$/, "")}/${file.originalname}`
      : file.originalname;

    debugRegular(`[upload-service.js LINE 267]: Target object name: "${objectName}"`);
    debugRegular(`[upload-service.js LINE 268]: MinIO putObject params:`, {
      bucket: bucketName,
      objectName: objectName,
      bufferSize: file.buffer ? file.buffer.length : "no buffer",
      sizeParam: file.size,
    });

    try {
      const uploadInfo = await this.minioClient.putObject(
        bucketName,
        objectName,
        file.buffer,
        file.size,
        {
          "Content-Type": file.mimetype,
          "X-Amz-Meta-Original-Name": file.originalname,
          "X-Amz-Meta-Upload-Date": new Date().toISOString(),
        }
      );
      
      console.timeEnd(uploadTimer);
      debugRegular(
        `[upload-service.js LINE 290]: Successfully uploaded: ${objectName} (ETag: ${uploadInfo.etag})`
      );

      return [
        {
          originalName: file.originalname,
          objectName: objectName,
          size: file.size,
          mimetype: file.mimetype,
          etag: uploadInfo.etag,
          versionId: uploadInfo.versionId,
        },
      ];
    } catch (error) {
      console.timeEnd(uploadTimer);
      debugRegular(`[upload-service.js LINE 305]: Regular file upload failed for ${file.originalname}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update JSON metadata file using already extracted EXIF data (async, non-blocking)
   * @param {string} bucketName - MinIO bucket name
   * @param {Array} uploadResult - Upload result
   * @param {Object} extractedMetadata - Already extracted EXIF metadata
   * @param {string} originalFilename - Original filename for logging
   */
  async updateJsonMetadataAsync(
    bucketName,
    uploadResult,
    extractedMetadata,
    originalFilename
  ) {
    
    
    try {
      // Use the metadata service to update the JSON file with extracted data
      await this.metadataService.updateFolderMetadata(
        bucketName,
        uploadResult.objectName,
        extractedMetadata,
        uploadResult
      );

      debugMetadata(
        `[upload-service.js LINE 335]: Successfully updated JSON metadata for ${uploadResult.objectName}`
      );
    } catch (error) {
      throw new Error(
        ` LINE 339 - Failed to update JSON metadata for ${uploadResult.objectName}: ${error.message}`
      );
    }
  }

  /**
   * Process multiple files in batch
   */
  async processMultipleFiles(files, bucketName, folderPath = "") {
    debugBatch(
      `[upload-service.js LINE 349]: Starting batch processing of ${files.length} files`
    );
    const allResults = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      try {
        const results = await this.processAndUploadFile(
          file,
          bucketName,
          folderPath
        );
        allResults.push(...results);
        debugBatch(
          `[upload-service.js LINE 365]: Successfully processed file ${i + 1}/${files.length}: ${file.originalname} (${results.length} variants)`
        );
      } catch (error) {
        debugBatch(
          `[upload-service.js LINE 369]: Failed to process file ${i + 1}/${files.length}: ${file.originalname} - ${error.message}`
        );
        errors.push({
          filename: file.originalname,
          error: error.message,
        });
      }
    }

    debugBatch(
      `[upload-service.js LINE 379]: Batch processing completed - Success: ${allResults.length} variants, Errors: ${errors.length} files`
    );
    
    if (errors.length > 0) {
      debugBatch(`[upload-service.js LINE 383]: Failed files:`, errors.map(e => `${e.filename}: ${e.error}`));
    }
    
    return { results: allResults, errors };
  }
}

module.exports = UploadService;