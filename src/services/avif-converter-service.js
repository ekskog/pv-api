// Using built-in fetch() available in Node.js 18+

class AvifConverterService {
  constructor() {
    this.baseUrl = process.env.AVIF_CONVERTER_URL || 'http://localhost:3000';
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
      
      // Append the blob as a file with proper filename (Go service expects 'image' field)
      formData.append('image', blob, originalName);

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

      // Go microservice returns binary AVIF data, not JSON
      const avifBuffer = await response.arrayBuffer();
      console.log(`[AVIF_CONVERTER] Received AVIF data: ${avifBuffer.byteLength} bytes`);

      // Create the base filename without extension
      const baseName = originalName.replace(/\.[^/.]+$/, '');
      
      // Create full-size variant from the converted AVIF
      const fullVariant = {
        filename: `${baseName}.avif`,
        content: Buffer.from(avifBuffer).toString('base64'),
        size: avifBuffer.byteLength,
        mimetype: 'image/avif',
        variant: 'full'
      };

      // For now, we'll use the same AVIF for thumbnail
      // TODO: In the future, we could modify the Go service to return multiple sizes
      const thumbnailVariant = {
        filename: `${baseName}_thumb.avif`,
        content: Buffer.from(avifBuffer).toString('base64'),
        size: avifBuffer.byteLength,
        mimetype: 'image/avif',
        variant: 'thumbnail'
      };

      console.log(`[AVIF_CONVERTER] Conversion successful: created full and thumbnail variants for ${originalName}`);

      // Return data in the format expected by upload-service.js
      return {
        success: true,
        data: {
          files: [fullVariant, thumbnailVariant]
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
