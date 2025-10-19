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
   * @returns {Object|null} Upload result (single object) or null if skipped
   */
  async processAndUploadFile(file, bucketName, folderPath = "") {
    const { mimetype, originalname, buffer } = file;
    debugUpload(`[(30)]: Processing file: ${originalname} with mimetype: ${mimetype}`);

    let extractedMetadata = null;
    let uploadResult = null;

    try {
      if (mimetype === "video/mp4" || mimetype === "video/mov" || mimetype === "video/avi" || mimetype === "video/quicktime") {
        uploadResult = await this.processVideoFile(file, bucketName, folderPath);
      } else {
        if (mimetype !== "image/heic" && mimetype !== "image/jpeg") return null;

        // PHOTOS ONLY
        // Step 1: Extract metadata
        extractedMetadata = await this.metadataService.extractEssentialMetadata(buffer, originalname);
        //debugUpload(`[(43)]: Extracted metadata for ${originalname}: ${JSON.stringify(extractedMetadata)}`);

        // Step 2: Convert and upload image
        uploadResult = await this.processImageFile(file, bucketName, folderPath, mimetype);
        //debugUpload(`[(47)]: Uploaded file ${originalname} as ${uploadResult.objectName}`);

        // Step 3: Try updating JSON metadata (non-blocking)
        if (uploadResult && extractedMetadata) {
          this.updateJsonMetadataAsync(bucketName, uploadResult, extractedMetadata, originalname)
            .then(() => {
             // debugUpload(`[upload-service.js (52)]: Updated JSON metadata for ${originalname}`
            })
            .catch((err) => {
              //debugUpload(`[(55)]: Failed to update JSON metadata for ${originalname}: ${err.message}`);
            });
        }
      }
      return uploadResult;
    } catch (error) {
      throw new Error(`Failed processing ${originalname}: ${error.message}`);
    } finally {
      // Release buffer memory
      if (file.buffer) {
        file.buffer = null;
      }
      // Note: global.gc() is not available in production (requires --expose-gc flag)
      // Uncomment below if running with --expose-gc for manual GC triggering
      // if (global.gc) {
      //   global.gc();
      //   const memAfterGC = process.memoryUsage();
      //   //debugUpload(`[(69)]: Memory after GC: ${(memAfterGC.heapUsed / 1024 / 1024).toFixed(2)}MB heap, ${(memAfterGC.rss / 1024 / 1024).toFixed(2)}MB RSS`);
      // }
    }
  }


  /**
   * Process image files (HEIC or JPEG) - convert using microservice and upload
   */
  async processImageFile(file, bucketName, folderPath, mimetype) {
    try {
      const conversionResult = await this.avifConverter.convertImage(
        file.buffer,
        file.originalname,
        file.mimetype
      );

      const convertedFile = this._processConvertedFileFromMicroservice(conversionResult.data.files);

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

      return {
        originalName: file.originalname,
        objectName,
        size: convertedFile.size,
        mimetype: convertedFile.mimetype,
        etag: uploadInfo.etag,
        versionId: uploadInfo.versionId,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Process video file - upload directly to MinIO without conversion
   */
  async processVideoFile(file, bucketName, folderPath) {
    const videoTimer = `Video-upload-${file.originalname}`;

    const maxSizeMB = 2000; // 2GB limit
    const fileSizeMB = file.size / 1024 / 1024;
    if (fileSizeMB > maxSizeMB) {
      throw new Error(
        `Video file too large: ${fileSizeMB.toFixed(2)}MB. Maximum allowed: ${maxSizeMB}MB`
      );
    }

    try {
      const objectName = folderPath
        ? `${folderPath.replace(/\/$/, "")}/${file.originalname}`
        : file.originalname;

      const uploadInfo = await this.minioClient.putObject(
        bucketName,
        objectName,
        file.buffer,
        file.size,
        {
          "Content-Type": file.mimetype || "video/quicktime",
          "X-Amz-Meta-Original-Name": file.originalname,
          "X-Amz-Meta-Upload-Date": new Date().toISOString(),
          "X-Amz-Meta-File-Type": "video",
          "X-Amz-Meta-Source": "iPhone",
        }
      );

      console.timeEnd(videoTimer);

      return {
        originalName: file.originalname,
        objectName,
        size: file.size,
        mimetype: file.mimetype || "video/quicktime",
        etag: uploadInfo.etag,
        versionId: uploadInfo.versionId,
        fileType: "video",
      };
    } catch (error) {
      console.timeEnd(videoTimer);
      throw error;
    }
  }

  /**
   * Process converted file from microservice
   */
  _processConvertedFileFromMicroservice(microserviceFiles) {
    const fileData = microserviceFiles[0];
    if (!fileData) {
      throw new Error("No converted file received from microservice");
    }

    try {
      const fileBuffer = Buffer.from(fileData.content, "base64");

      return {
        buffer: fileBuffer,
        filename: fileData.filename,
        size: fileBuffer.length,
        mimetype: fileData.mimetype || "image/avif",
      };
    } catch (error) {
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

      return {
        originalName: file.originalname,
        objectName,
        size: file.size,
        mimetype: file.mimetype,
        etag: uploadInfo.etag,
        versionId: uploadInfo.versionId,
      };
    } catch (error) {
      console.timeEnd(uploadTimer);
      throw error;
    }
  }

  /**
   * Update JSON metadata file
   */
  async updateJsonMetadataAsync(bucketName, uploadResult, extractedMetadata, originalFilename) {
    try {
      await this.metadataService.updateFolderMetadata(
        bucketName,
        uploadResult.objectName,
        extractedMetadata,
        uploadResult
      );
    } catch (error) {
      throw new Error(
        `Failed to update JSON metadata for ${uploadResult.objectName}: ${error.message}`
      );
    }
  }

  /**
   * Process multiple files in batch
   */
  async processMultipleFiles(files, bucketName, folderPath = "") {
    const allResults = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        const result = await this.processAndUploadFile(file, bucketName, folderPath);
        allResults.push(result);
      } catch (error) {
        errors.push({
          filename: file.originalname,
          error: error.message,
        });
      }
    }

    return { results: allResults, errors };
  }
}

module.exports = UploadService;
