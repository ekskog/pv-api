const debug = require("debug");

// Debug namespaces
const debugConverter = debug("photovault:converter");
const debugHealth = debug("photovault:converter:health");
const debugConversion = debug("photovault:converter:conversion");

// Using built-in fetch() available in Node.js 18+

class AvifConverterService {
  constructor() {
    // Consolidated microservice configuration
    this.converterUrl = process.env.AVIF_CONVERTER_URL;
    this.converterTimeout = parseInt(process.env.AVIF_CONVERTER_TIMEOUT);
    
    debugConverter(`Initialized with URL: ${this.converterUrl}, timeout: ${this.converterTimeout}ms`);
  }

  /**
   * Check if the converter microservice is healthy
   * @returns {Object} Health check result
   */
  async checkHealth() {
    try {
      debugHealth(`Checking health at: ${this.converterUrl}/health`);
      
      const response = await fetch(`${this.converterUrl}/health`, {
        method: 'GET',
        timeout: 5000 // 5 second timeout for health checks
      });
      
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      debugHealth(`Health check successful:`, data);
      
      return {
        success: true,
        data: data
      };
    } catch (error) {
      debugHealth(`Health check failed: ${error.message}`);
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
    debugConversion(`Starting conversion for: ${originalName} (${mimeType})`);
    debugConversion(`File buffer size: ${fileBuffer.length} bytes`);
    
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

    debugConversion(`Sending conversion request to: ${this.converterUrl}${endpoint}`);
    debugConversion(`Request timeout: ${this.converterTimeout}ms`);
    
    const response = await fetch(`${this.converterUrl}${endpoint}`, {
      method: 'POST',
      body: formData,
      timeout: this.converterTimeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      debugConversion(`Conversion request failed: ${response.status} ${response.statusText} - ${errorText}`);
      throw new Error(`Conversion failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const responseData = await response.json();
    debugConversion(`Received response from converter:`, {
      success: responseData.success,
      hasData: !!responseData.data,
      hasFullSize: !!(responseData.data && responseData.data.fullSize)
    });

    if (!responseData.success) {
      debugConversion(`Conversion failed: ${responseData.error || 'Unknown error'}`);
      throw new Error(`Conversion failed: ${responseData.error || 'Unknown error'}`);
    }

    // Fix: Access fullSize from the correct path (responseData.data.fullSize)
    if (!responseData.data || !responseData.data.fullSize) {
      debugConversion(`Conversion failed: Missing fullSize in response data`);
      throw new Error(`Conversion failed: Missing fullSize in response data`);
    }

    const baseName = originalName.replace(/\.(jpg|jpeg|heic)$/i, '');
    debugConversion(`Base name for output: ${baseName}`);
    
    const files = [];
    files.push({
      filename: `${baseName}.avif`,
      content: responseData.data.fullSize.content, // Access from correct path
      size: responseData.data.fullSize.size,
      mimetype: 'image/avif',
      variant: 'full'
    });

    debugConversion(`Processed: full-size (${responseData.data.fullSize.size}B) -> ${baseName}.avif`);

    return {
      success: true,
      data: {
        files: files
      }
    };

  } catch (error) {
    debugConversion(`Conversion failed for ${originalName}: ${error.message}`);
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
    debugHealth(`Checking all services health`);
    const health = await this.checkHealth();
    const result = {
      converter: health,
      overallStatus: health.success ? 'healthy' : 'degraded'
    };
    
    debugHealth(`All services health check result:`, result);
    return result;
  }

  /**
   * Check if the microservice is available and responding
   * @returns {boolean} True if the microservice is available
   */
  async isAvailable() {
    debugHealth(`Checking if converter service is available`);
    const health = await this.checkHealth();
    const available = health.success;
    debugHealth(`Converter service available: ${available}`);
    return available;
  }
}

module.exports = AvifConverterService;