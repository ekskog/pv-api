const debug = require("debug");

// Debug namespaces
const debugConverter = debug("photovault:converter");
const debugHealth = debug("photovault:converter:health");
const debugConversion = debug("photovault:converter:conversion");

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
        timeout: 60000 // 1 minute timeout for health checks
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

      const endpoint = '/convert';
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: mimeType });
      formData.append('image', blob, originalName);
      formData.append('mimeType', mimeType);

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

      if (!responseData.data || !responseData.data.fullSize) {
        throw new Error(`Conversion failed: Missing fullSize in response data`);
      }

      const baseName = originalName.replace(/\.(jpg|jpeg|heic)$/i, '');
      const files = [];
      files.push({
        filename: `${baseName}.avif`,
        content: responseData.data.fullSize.content,
        size: responseData.data.fullSize.size,
        mimetype: 'image/avif',
        variant: 'full'
      });

      return {
        success: true,
        data: {
          files: files
        }
      };

    } catch (error) {
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
    const result = {
      converter: health,
      overallStatus: health.success ? 'healthy' : 'degraded'
    };
    
    return result;
  }

  /**
   * Check if the microservice is available and responding
   * @returns {boolean} True if the microservice is available
   */
  async isAvailable() {
    const health = await this.checkHealth();
    const available = health.success;
    return available;
  }
}

module.exports = AvifConverterService;