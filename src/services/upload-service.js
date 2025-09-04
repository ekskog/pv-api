const AvifConverterService = require("./avif-converter-service");
const MetadataService = require("./metadata-service");
const debug = require("debug");
const debugUpload = debug("photovault:upload-service");

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
   * @returns {Object} Upload result (single object)
   */
  async processAndUploadFile(file, bucketName, folderPath = "") {
    let mimetype = file.mimetype;
    let extractedMetadata = null;
    let uploadResult = null;

    try {
      if (mimetype === "image/heic" || mimetype === "image/jpeg") {
        // Extract metadata first
        extractedMetadata = await this.metadataService.extractEssentialMetadata(
          file.buffer,
          file.originalname
        );
        debugUpload(
          `[upload-service.js (40)]: Extracted metadata for ${file.originalname}: ${JSON.stringify(extractedMetadata)}}`
        );

        // Process image file
        uploadResult = await this.processImageFile(
          file,
          bucketName,
          folderPath,
          mimetype
        );
        debugUpload(`[upload-service.js (41)]: uploadresult: ${JSON.stringify(uploadResult)}`);

        // Update JSON metadata with already extracted data (blocking)
        if (uploadResult && extractedMetadata) {
          try {
            await this.updateJsonMetadataAsync(
              bucketName,
              uploadResult,
              extractedMetadata,
              file.originalname
            );
            debugUpload(`[upload-service.js (51)]: Updated JSON metadata for ${file.originalname}`);
          } catch (error) {
            throw new Error(
              `Failed to update JSON metadata for ${file.originalname}: ${error.message}`
            );
          }
        }

        return uploadResult;
      }
    } catch (error) {
      // NO FALLBACK - If AVIF conversion fails, fail the entire upload
      // debugUpload(`[upload-service.js LINE 70]: AVIF conversion failed for ${file.originalname} - NOT uploading original file as per requirements`);
      throw error;
    } finally {
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        const memAfterGC = process.memoryUsage();
        debugUpload(
          `[upload-service.js LINE 78]: Memory after GC: ${(
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
   * Process image files (HEIC or JPEG) - convert using microservice and upload
   * @param {Object} file - Multer file object
   * @param {string} bucketName - MinIO bucket name
   * @param {string} folderPath - Upload folder path
   * @param {string} mimetype - File mimetype (e.g., 'image/heic', 'image/jpeg')
   * @returns {Object} Upload result (single object)
   */
  async processImageFile(file, bucketName, folderPath, mimetype) {
    const uploadTimer = `${mimetype}-upload-${file.originalname}`;
    try {
      // Convert using microservice
      const conversionResult = await this.avifConverter.convertImage(
        file.buffer,
        file.originalname,
        file.mimetype
      );

      // Process the converted file from microservice
      // debugImage(`[upload-service.js LINE 109: Processing converted file from microservice for ${file.originalname}`);
      const convertedFile = this._processConvertedFileFromMicroservice(
        conversionResult.data.files
      );

      // Upload the converted file to MinIO
      const objectName = folderPath
        ? `${folderPath.replace(/\/$/, "")}/${convertedFile.filename}`
        : convertedFile.filename;

      const uploadInfo = await this.minioClient.putObject(
        bucketName,
        objectName,
        convertedFile.buffer,
        convertedFile.size,
        {
          "Content-Type": convertedFile.mimetype,
          "X-Amz-Meta-Original-Name": file.originalname,
          "X-Amz-Meta-Upload-Date": new Date().toISOString(),
          "X-Amz-Meta-Converted-By": "avif-converter-microservice",
        }
      );

      const uploadResult = {
        originalName: file.originalname,
        objectName: objectName,
        size: convertedFile.size,
        mimetype: convertedFile.mimetype,
        etag: uploadInfo.etag,
        versionId: uploadInfo.versionId,
      };

      // debugImage(`[upload-service.js LINE 146]: Image processing completed for ${file.originalname}`);
      return uploadResult;
    } catch (error) {
      // debugImage(`[upload-service.js LINE 149]: ${mimetype} processing failed for ${file.originalname}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process video file - upload directly to MinIO without conversion
   * @param {Object} file - Multer file object
   * @param {string} bucketName - MinIO bucket name
   * @param {string} folderPath - Upload folder path
   * @returns {Object} Upload result (single object)
   */
  async processVideoFile(file, bucketName, folderPath) {
    const videoTimer = `Video-upload-${file.originalname}`;

    // Check file size limit for videos (larger than images)
    const maxSizeMB = 2000; // 2GB limit for videos
    const fileSizeMB = file.size / 1024 / 1024;
    if (fileSizeMB > maxSizeMB) {
      // debugVideo(
      //   `[upload-service.js LINE 170]: Video file too large: ${file.originalname} (${fileSizeMB.toFixed(2)}MB > ${maxSizeMB}MB)`
      // );
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

      // debugVideo(`[upload-service.js LINE 185]: Uploading video to MinIO: ${objectName}`);

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

      return {
        originalName: file.originalname,
        objectName: objectName,
        size: file.size,
        mimetype: file.mimetype || "video/quicktime",
        etag: uploadInfo.etag,
        versionId: uploadInfo.versionId,
        fileType: "video",
      };
    } catch (error) {
      console.timeEnd(videoTimer);
      // debugVideo(
      //   `Video upload failed for ${file.originalname}: ${error.message}`
      // );
      throw error;
    }
  }

  /**
   * Process converted file from microservice (single file instead of variants)
   * @param {Array} microserviceFiles - Array of file objects with base64 content
   * @returns {Object} Single converted file object suitable for MinIO upload
   */
  _processConvertedFileFromMicroservice(microserviceFiles) {
    // Take the first (and presumably only) file from the microservice response
    const fileData = microserviceFiles[0];

    if (!fileData) {
      throw new Error("No converted file received from microservice");
    }

    try {
      // debugImage(`[upload-service.js LINE 231]: Processing converted file: ${fileData.filename}`);

      // Decode base64 content back to buffer
      const fileBuffer = Buffer.from(fileData.content, "base64");

      const convertedFile = {
        buffer: fileBuffer,
        filename: fileData.filename,
        size: fileBuffer.length,
        mimetype: fileData.mimetype || "image/avif",
      };

      // debugImage(
      //   `[upload-service.js LINE 247]: Processed converted file: ${fileData.filename} (${(fileBuffer.length / 1024).toFixed(2)}KB)`
      // );

      return convertedFile;
    } catch (error) {
      // debugImage(
      //   `[upload-service.js LINE 251]: Failed to process file ${fileData.filename}: ${error.message}`
      // );
      throw error;
    }
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

    // debugRegular(`[upload-service.js LINE 267]: Target object name: "${objectName}"`);

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
      // debugRegular(
      //   `[upload-service.js LINE 288]: Successfully uploaded: ${objectName} (ETag: ${uploadInfo.etag})`
      // );

      return {
        originalName: file.originalname,
        objectName: objectName,
        size: file.size,
        mimetype: file.mimetype,
        etag: uploadInfo.etag,
        versionId: uploadInfo.versionId,
      };
    } catch (error) {
      console.timeEnd(uploadTimer);
      // debugRegular(`[upload-service.js LINE 303]: Regular file upload failed for ${file.originalname}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update JSON metadata file using already extracted EXIF data (async, non-blocking)
   * @param {string} bucketName - MinIO bucket name
   * @param {Object} uploadResult - Upload result
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

      // debugMetadata(
      //   `[upload-service.js LINE 333]: Successfully updated JSON metadata for ${uploadResult.objectName}`
      // );
    } catch (error) {
      throw new Error(
        ` LINE 337 - Failed to update JSON metadata for ${uploadResult.objectName}: ${error.message}`
      );
    }
  }

  /**
   * Process multiple files in batch
   */
  async processMultipleFiles(files, bucketName, folderPath = "") {
    // debugBatch(
    //   `[upload-service.js LINE 347]: Starting batch processing of ${files.length} files`
    // );
    const allResults = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        const result = await this.processAndUploadFile(
          file,
          bucketName,
          folderPath
        );
        allResults.push(result);
        // debugBatch(
        //   `[upload-service.js LINE 363]: Successfully processed file ${i + 1}/${files.length}: ${file.originalname}`
        // );
      } catch (error) {
        // debugBatch(
        //   `[upload-service.js LINE 367]: Failed to process file ${i + 1}/${files.length}: ${file.originalname} - ${error.message}`
        // );
        errors.push({
          filename: file.originalname,
          error: error.message,
        });
      }
    }

    // debugBatch(
    //   `[upload-service.js LINE 377]: Batch processing completed - Success: ${allResults.length} files, Errors: ${errors.length} files`
    // );

    if (errors.length > 0) {
      // debugBatch(`[upload-service.js LINE 381]: Failed files:`, errors.map(e => `${e.filename}: ${e.error}`));
    }

    return { results: allResults, errors };
  }
}

module.exports = UploadService;
