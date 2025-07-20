// Upload Service - Handles file uploads with AVIF conversion (NO FALLBACKS)
//
// IMPORTANT: This service enforces strict AVIF conversion requirements:
// - Only successfully converted AVIF files are uploaded to MinIO
// - If AVIF conversion fails, the original file is NOT uploaded
// - Upload failures are properly propagated to the client
// - No fallback mechanisms are implemented by design
const AvifConverterService = require("./avif-converter-service");
const MetadataService = require("./metadata-service");

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
        extractedMetadata = await this.metadataService.extractExifFromBuffer(file.buffer, file.originalname);
        uploadResult = await this.processImageFile(file, bucketName, folderPath, mimetype);
        console.log(`[UPLOAD SERVICE] uploadResult for ${file.originalname}:`, uploadResult);

        // Update JSON metadata with already extracted data (non-blocking)
        console.log(`[UPLOAD SERVICE] Updating JSON metadata with ${extractedMetadata}`);
        if (uploadResult && extractedMetadata) {
          this.updateJsonMetadataAsync(
            bucketName,
            uploadResult,
            extractedMetadata,
            file.originalname
          ).catch((error) => {
            console.error(`[METADATA] Failed to update JSON metadata for ${file.originalname}:`, error.message);
          });
        }

        return uploadResult;
      };
    } catch (error) {
      console.error(`[UPLOAD SERVICE] Error processing file ${file.originalname}:`, error.message);
      // NO FALLBACK - If AVIF conversion fails, fail the entire upload
      console.log(`[UPLOAD SERVICE] AVIF conversion failed for ${file.originalname} - NOT uploading original file as per requirements`);
      throw error;
    } finally {
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        const memAfterGC = process.memoryUsage();
        console.log(
          `[UPLOAD SERVICE] Memory after GC: ${(
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
    console.time(uploadTimer);
    console.log(`[UPLOAD-SERVICE DEBUG] Processing ${mimetype} file: ${file.originalname}`);
    try {
      // Convert using microservice
      const conversionResult = await this.avifConverter.convertImage(
        file.buffer,
        file.originalname,
        file.mimetype
      );

      console.log(`[UPLOAD-SERVICE] Microservice conversion completed, received ${conversionResult.data.files ? conversionResult.data.files.length : 0} files`);

      // Process the actual file contents returned from microservice
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

      console.timeEnd(uploadTimer);
      return uploadResult;
    } catch (error) {
      console.timeEnd(uploadTimer);
      console.error(`[UPLOAD-SERVICE] ${mimetype} processing failed:`, error.message);
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
    console.log(
      `[VIDEO_UPLOAD] Processing video file: ${file.originalname} (${(
        file.size /
        1024 /
        1024
      ).toFixed(2)}MB, ${file.mimetype})`
    );

    // Check file size limit for videos (larger than images)
    const maxSizeMB = 2000; // 2GB limit for videos
    const fileSizeMB = file.size / 1024 / 1024;
    if (fileSizeMB > maxSizeMB) {
      console.error(
        `[VIDEO_UPLOAD] Video file too large: ${file.originalname
        } (${fileSizeMB.toFixed(2)}MB > ${maxSizeMB}MB)`
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

      console.log(`[VIDEO_UPLOAD] Uploading video to: ${objectName}`);

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
      console.log(
        `[VIDEO_UPLOAD] Successfully uploaded video: ${objectName} (ETag: ${uploadInfo.etag})`
      );

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
      console.error(
        `[VIDEO_UPLOAD] Video upload failed for ${file.originalname}:`,
        error.message
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
        // Decode base64 content back to buffer
        const fileBuffer = Buffer.from(fileData.content, "base64");

        variants[fileData.variant] = {
          buffer: fileBuffer,
          filename: fileData.filename,
          size: fileBuffer.length,
          mimetype: fileData.mimetype || "image/avif",
        };

        console.log(
          `[UPLOAD SERVICE] Processed ${fileData.variant} variant: ${fileData.filename
          } (${(fileBuffer.length / 1024).toFixed(2)}KB)`
        );
      } catch (error) {
        console.error(
          `[UPLOAD SERVICE] Failed to process file ${fileData.filename}:`,
          error.message
        );
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
    console.log(
      `[REGULAR_UPLOAD] Uploading regular file: ${file.originalname} (${(
        file.size /
        1024 /
        1024
      ).toFixed(2)}MB)`
    );

    // DEBUG: Log all file properties to understand mobile upload differences
    console.log(`[REGULAR_UPLOAD] File object details:`, {
      originalname: file.originalname,
      filename: file.filename,
      fieldname: file.fieldname,
      mimetype: file.mimetype,
      size: file.size,
      bufferLength: file.buffer ? file.buffer.length : "no buffer",
      encoding: file.encoding,
    });

    const objectName = folderPath
      ? `${folderPath.replace(/\/$/, "")}/${file.originalname}`
      : file.originalname;

    console.log(`[REGULAR_UPLOAD] Target object name: "${objectName}"`);
    console.log(`[REGULAR_UPLOAD] MinIO putObject params:`, {
      bucket: bucketName,
      objectName: objectName,
      bufferSize: file.buffer ? file.buffer.length : "no buffer",
      sizeParam: file.size,
    });

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
    console.log(
      `[REGULAR_UPLOAD] Successfully uploaded: ${objectName} (ETag: ${uploadInfo.etag})`
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
    console.log(
      `[UPLOAD-SERVICE METADATA] Starting JSON metadata update for ${originalFilename} with ${uploadResult.length} uploads`
    );
    try {
      console.log(
        `[UPLOAD-SERVICE] Updating JSON metadata for ${uploadResult.objectName} using pre-extracted EXIF data`
      );

      // Use the metadata service to update the JSON file with extracted data
      await this.metadataService.updateFolderMetadata(
        bucketName,
        uploadResult.objectName,
        extractedMetadata,
        uploadResult
      );

      console.log(
        `[METADATA] Successfully updated JSON metadata for ${uploadResult.objectName}`
      );
    } catch (error) {
      console.error(
        `[METADATA] Failed to update JSON metadata for ${uploadResult.objectName}:`,
        error.message
      );
    }
  }

  /**
   * Process multiple files in batch
   */
  async processMultipleFiles(files, bucketName, folderPath = "") {
    console.log(
      `[BATCH_PROCESS] Starting batch processing of ${files.length} files`
    );
    const allResults = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(
        `[BATCH_PROCESS] Processing file ${i + 1}/${files.length}: ${file.originalname
        }`
      );
      try {
        const results = await this.processAndUploadFile(
          file,
          bucketName,
          folderPath
        );
        allResults.push(...results);
        console.log(
          `[BATCH_PROCESS] Successfully processed file ${i + 1}/${files.length
          }: ${file.originalname} (${results.length} variants)`
        );
      } catch (error) {
        console.error(
          `[BATCH_PROCESS] Failed to process file ${i + 1}/${files.length}: ${file.originalname
          }`,
          error.message
        );
        errors.push({
          filename: file.originalname,
          error: error.message,
        });
      }
    }

    console.log(
      `[BATCH_PROCESS] Batch processing completed - Success: ${allResults.length} variants, Errors: ${errors.length} files`
    );
    return { results: allResults, errors };
  }
}

module.exports = UploadService;
