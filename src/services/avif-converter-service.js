// Using built-in fetch() available in Node.js 18+

class AvifConverterService {
  constructor() {
    this.baseUrl = process.env.AVIF_CONVERTER_URL || 'http://localhost:8000';
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
      
      // Determine the correct endpoint based on file type
      const isHEIC = /\.(heic|heif)$/i.test(originalName);
      const isJPEG = /\.(jpg|jpeg)$/i.test(originalName);
      
      let endpoint;
      if (isHEIC) {
        endpoint = '/convert';
      } else if (isJPEG) {
        endpoint = '/convert-jpeg';
      } else {
        throw new Error(`Unsupported file type for AVIF conversion: ${originalName}`);
      }
      
      // Create form data for multipart upload using native FormData
      const formData = new FormData();
      
      // Create a Blob from the buffer with proper type
      const blob = new Blob([fileBuffer], { type: mimeType });
      
      // Append the blob as a file with proper filename (our Python API expects 'file' field)
      formData.append('file', blob, originalName);

      console.log(`[AVIF_CONVERTER] Sending conversion request to: ${this.baseUrl}${endpoint}`);
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        body: formData,
        timeout: this.timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Conversion failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      // Log the raw response before JSON parsing to debug production issues
      const responseText = await response.text();
      console.log(`[AVIF_CONVERTER] Raw response from converter (first 500 chars):`, responseText.substring(0, 500));
      console.log(`[AVIF_CONVERTER] Response length:`, responseText.length);

      // Parse the JSON response
      let conversionResult;
      try {
        conversionResult = JSON.parse(responseText);
      } catch (parseError) {
        console.error(`[AVIF_CONVERTER] JSON parsing failed. Raw response:`, responseText);
        throw new Error(`JSON parsing failed: ${parseError.message}`);
      }
      
      if (!conversionResult.success || !conversionResult.variants) {
        throw new Error(`Conversion failed: Invalid response format`);
      }
      
      console.log(`[AVIF_CONVERTER] Conversion successful: ${conversionResult.variants.length} variants for ${originalName}`);

      // Return data in the format expected by upload-service.js
      return {
        success: true,
        data: {
          files: conversionResult.variants.map(variant => ({
            filename: variant.filename,
            content: variant.content, // Already base64 encoded by Python service
            size: variant.size,
            mimetype: variant.mimetype,
            variant: variant.variant
          }))
        }
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
