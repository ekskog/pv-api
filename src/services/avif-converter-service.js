// Using built-in fetch() available in Node.js 18+
const FormData = require('form-data');

class AvifConverterService {
  constructor() {
    this.baseUrl = process.env.AVIF_CONVERTER_URL || 'http://localhost:3002';
    this.timeout = parseInt(process.env.AVIF_CONVERTER_TIMEOUT) || 300000; // 5 minutes default
  }

  /**
   * Check if the AVIF converter microservice is healthy
   * @returns {Object} Health check result
   */
  async checkHealth() {
    try {
      console.log(`[AVIF_CONVERTER] Checking health at: ${this.baseUrl}/health`);
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        timeout: 5000 // 5 second timeout for health checks
      });
      
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      console.log(`[AVIF_CONVERTER] Health check successful:`, data);
      
      return {
        success: true,
        data: data
      };
    } catch (error) {
      console.error(`[AVIF_CONVERTER] Health check failed:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Convert an image file to AVIF using the microservice
   * @param {Buffer} fileBuffer - Image file buffer
   * @param {string} originalName - Original filename
   * @param {string} mimeType - Original file MIME type
   * @param {boolean} returnContents - Whether to return file contents or just paths
   * @returns {Object} Conversion result with AVIF files
   */
  async convertImage(fileBuffer, originalName, mimeType, returnContents = true) {
    try {
      console.log(`[AVIF_CONVERTER] Converting image: ${originalName} (${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB, ${mimeType})`);
      
      // Create form data for multipart upload using form-data package
      const formData = new FormData();
      
      // Append the buffer as a file with proper filename and mime type
      formData.append('image', fileBuffer, {
        filename: originalName,
        contentType: mimeType
      });
      
      // Add parameter to request file contents
      if (returnContents) {
        formData.append('returnContents', 'true');
      }

      console.log(`[AVIF_CONVERTER] Sending conversion request to: ${this.baseUrl}/convert`);
      const response = await fetch(`${this.baseUrl}/convert`, {
        method: 'POST',
        body: formData,
        timeout: this.timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Conversion failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Conversion failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();
      console.log(`[AVIF_CONVERTER] Conversion successful:`, {
        success: result.success,
        filesCount: result.files ? result.files.length : 0
      });

      return {
        success: true,
        data: result
      };

    } catch (error) {
      console.error(`[AVIF_CONVERTER] Conversion failed for ${originalName}:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if the microservice is available and responding
   * @returns {boolean} True if microservice is available
   */
  async isAvailable() {
    const health = await this.checkHealth();
    return health.success;
  }
}

module.exports = AvifConverterService;
