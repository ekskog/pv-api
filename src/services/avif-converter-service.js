// Using built-in fetch() available in Node.js 18+

class AvifConverterService {
  constructor() {
    this.baseUrl = process.env.AVIF_CONVERTER_URL;
    this.timeout = parseInt(process.env.AVIF_CONVERTER_TIMEOUT) || 300000; // 5 minutes default
    
    if (!this.baseUrl) {
      console.error('[AVIF_CONVERTER] CRITICAL ERROR: AVIF_CONVERTER_URL environment variable not set!');
      throw new Error('AVIF_CONVERTER_URL environment variable is required');
    }
  }

  /**
   * Check if the AVIF converter microservice is healthy
   * @returns {Object} Health check result
   */
  async checkHealth() {
    try {
      //console.log(`[AVIF_CONVERTER] Checking health at: ${this.baseUrl}/health`);
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        timeout: 5000 // 5 second timeout for health checks
      });
      
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      //console.log(`[AVIF_CONVERTER] Health check successful:`, data);
      
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
      //console.log(`[AVIF_CONVERTER] Converting image: ${originalName} (${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB, ${mimeType})`);
      
      // Check if file type is supported for AVIF conversion
      const isHEIC = /\.(heic|heif)$/i.test(originalName);
      const isJPEG = /\.(jpg|jpeg)$/i.test(originalName);
      
      if (!isHEIC && !isJPEG) {
        throw new Error(`Unsupported file type for AVIF conversion: ${originalName}`);
      }
      
      // Use single endpoint for all supported formats
      const endpoint = '/convert';
      
      // Create form data for multipart upload using native FormData
      const formData = new FormData();
      
      // Create a Blob from the buffer with proper type
      const blob = new Blob([fileBuffer], { type: mimeType });
      
      // Append the blob as a file with proper filename (Python service expects 'file' field)
      formData.append('file', blob, originalName);

      //console.log(`[AVIF_CONVERTER] Sending conversion request to: ${this.baseUrl}${endpoint}`);
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        body: formData,
        timeout: this.timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Conversion failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      // Python microservice returns JSON with base64-encoded variants
      const responseData = await response.json();
      //console.log(`[AVIF_CONVERTER] Received JSON response with ${responseData.variants?.length || 0} variants`);

      if (!responseData.success || !responseData.variants || responseData.variants.length === 0) {
        throw new Error('Conversion failed: No variants returned from microservice');
      }

      // Process the variants returned by the microservice
      const files = [];

      for (const variant of responseData.variants) {
        //console.log(`[AVIF_CONVERTER] Processing variant: ${variant.variant} (${variant.size} bytes)`);
        
        // Convert to the format expected by upload service
        files.push({
          filename: variant.filename,
          content: variant.content, // Already base64 encoded
          size: variant.size,
          mimetype: variant.mimetype,
          variant: variant.variant
        });
      }

      //console.log(`[AVIF_CONVERTER] Successfully processed ${files.length} variants`);
      return {
        success: true,
        data: {
          files: files
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
