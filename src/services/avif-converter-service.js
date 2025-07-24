// Using built-in fetch() available in Node.js 18+

class AvifConverterService {
  constructor() {
    // Consolidated microservice configuration
    this.converterUrl = process.env.AVIF_CONVERTER_URL;
    this.converterTimeout = parseInt(process.env.AVIF_CONVERTER_TIMEOUT);
  }

  /**
   * Check if the converter microservice is healthy
   * @returns {Object} Health check result
   */
  async checkHealth() {
    try {
      const response = await fetch(`${this.converterUrl}/health`, {
        method: 'GET',
        timeout: 5000 // 5 second timeout for health checks
      });
      
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
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
    // Use single endpoint for all supported formats
    const endpoint = '/convert';
    // Create form data for multipart upload using native FormData
    const formData = new FormData();
    // Create a Blob from the buffer with proper type
    const blob = new Blob([fileBuffer], { type: mimeType });
    
    // Append the blob as a file with proper filename
    const fieldName = 'image'; // Updated to match the converter's expected field
    formData.append(fieldName, blob, originalName);

    // Add MIME type to the form data to ensure it is passed to the microservice
    formData.append('mimeType', mimeType);

    console.log(`[AVIF_CONVERTER] Sending conversion request to: ${this.converterUrl}${endpoint}`);
    const response = await fetch(`${this.converterUrl}${endpoint}`, {
      method: 'POST',
      body: formData,
      timeout: this.converterTimeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Conversion failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const responseData = await response.json();

    if (!responseData.success) {
      throw new Error(`Conversion failed: ${responseData.error || 'Unknown error'}`);
    }

    // Fix: Access fullSize from the correct path (responseData.data.fullSize)
    if (!responseData.data || !responseData.data.fullSize) {
      throw new Error(`Conversion failed: Missing fullSize in response data`);
    }

    const baseName = originalName.replace(/\.(jpg|jpeg|heic)$/i, '');
    
    const files = [];
    files.push({
      filename: `${baseName}.avif`,
      content: responseData.data.fullSize.content, // Access from correct path
      size: responseData.data.fullSize.size,
      mimetype: 'image/avif',
      variant: 'full'
    });

    console.log(`[AVIF_CONVERTER] Processed: full-size (${responseData.data.fullSize.size}B)`);

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
   * Check health of the converter service
   * @returns {Object} Health check result
   */
  async checkAllServicesHealth() {
    const health = await this.checkHealth();
    return {
      converter: health,
      overallStatus: health.success ? 'healthy' : 'degraded'
    };
  }

  /**
   * Check if the microservice is available and responding
   * @returns {boolean} True if the microservice is available
   */
  async isAvailable() {
    const health = await this.checkHealth();
    return health.success;
  }
}

module.exports = AvifConverterService;
