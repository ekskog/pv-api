// Using built-in fetch() available in Node.js 18+

class AvifConverterService {
  constructor() {
    this.baseUrl = process.env.AVIF_CONVERTER_URL;
    this.timeout = parseInt(process.env.AVIF_CONVERTER_TIMEOUT) || 300000; // 5 minutes default
    
    // New JPEG2AVIF microservice configuration
    this.jpeg2avifUrl = process.env.JPEG2AVIF_CONVERTER_URL;
    this.jpeg2avifTimeout = parseInt(process.env.JPEG2AVIF_CONVERTER_TIMEOUT) || 300000;
    
    if (!this.baseUrl) {
      console.error('[AVIF_CONVERTER] CRITICAL ERROR: AVIF_CONVERTER_URL environment variable not set!');
      throw new Error('AVIF_CONVERTER_URL environment variable is required');
    }
    
    // Log configuration
    console.log(`[AVIF_CONVERTER] Configured services:`);
    console.log(`  - HEIC converter: ${this.baseUrl}`);
    console.log(`  - JPEG converter: ${this.jpeg2avifUrl || 'Not configured (will use HEIC converter)'}`);
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
   * Check if the JPEG2AVIF converter microservice is healthy
   * @returns {Object} Health check result
   */
  async checkJpeg2AvifHealth() {
    if (!this.jpeg2avifUrl) {
      return {
        success: false,
        error: 'JPEG2AVIF service not configured'
      };
    }

    try {
      console.log(`[AVIF_CONVERTER] Checking JPEG2AVIF health at: ${this.jpeg2avifUrl}/health`);
      const response = await fetch(`${this.jpeg2avifUrl}/health`, {
        method: 'GET',
        timeout: 5000 // 5 second timeout for health checks
      });
      
      if (!response.ok) {
        throw new Error(`JPEG2AVIF health check failed: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      console.log(`[AVIF_CONVERTER] JPEG2AVIF health check successful:`, data);
      
      return {
        success: true,
        data: data
      };
    } catch (error) {
      console.error(`[AVIF_CONVERTER] JPEG2AVIF health check failed:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check health of both services
   * @returns {Object} Combined health check result
   */
  async checkAllServicesHealth() {
    const heicHealth = await this.checkHealth();
    const jpegHealth = await this.checkJpeg2AvifHealth();
    
    return {
      heicConverter: heicHealth,
      jpegConverter: jpegHealth,
      overallStatus: heicHealth.success && (jpegHealth.success || !this.jpeg2avifUrl) ? 'healthy' : 'degraded'
    };
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
      
      // Determine which service to use based on file type
      let serviceUrl, serviceTimeout, serviceName;
      
      if (isJPEG && this.jpeg2avifUrl) {
        // Use the new memory-efficient JPEG2AVIF microservice for JPEG files
        serviceUrl = this.jpeg2avifUrl;
        serviceTimeout = this.jpeg2avifTimeout;
        serviceName = 'JPEG2AVIF';
        console.log(`[AVIF_CONVERTER] Using JPEG2AVIF microservice for ${originalName}`);
      } else if (isHEIC) {
        // Use the existing HEIC converter for HEIC files
        serviceUrl = this.baseUrl;
        serviceTimeout = this.timeout;
        serviceName = 'HEIC_CONVERTER';
        console.log(`[AVIF_CONVERTER] Using HEIC converter for ${originalName}`);
      } else {
        // NO FALLBACKS! Fail if the appropriate service is not configured
        if (isJPEG) {
          throw new Error(`JPEG2AVIF service not configured for JPEG file: ${originalName}`);
        } else {
          throw new Error(`No appropriate service configured for file: ${originalName}`);
        }
      }
      
      // Use single endpoint for all supported formats
      const endpoint = '/convert';
      
      // Create form data for multipart upload using native FormData
      const formData = new FormData();
      
      // Create a Blob from the buffer with proper type
      const blob = new Blob([fileBuffer], { type: mimeType });
      
      // Append the blob as a file with proper filename
      // Note: JPEG2AVIF service expects 'image' field, HEIC service expects 'file' field
      const fieldName = serviceName === 'JPEG2AVIF' ? 'image' : 'file';
      formData.append(fieldName, blob, originalName);

      console.log(`[AVIF_CONVERTER] Sending conversion request to ${serviceName}: ${serviceUrl}${endpoint}`);
      const response = await fetch(`${serviceUrl}${endpoint}`, {
        method: 'POST',
        body: formData,
        timeout: serviceTimeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Conversion failed (${serviceName}): ${response.status} ${response.statusText} - ${errorText}`);
      }

      // Both microservices return JSON with base64-encoded variants
      const responseData = await response.json();
      console.log(`[AVIF_CONVERTER] ${serviceName} response received for ${originalName}`);

      if (!responseData.success) {
        throw new Error(`Conversion failed (${serviceName}): ${responseData.error || 'Unknown error'}`);
      }

      // Process the variants returned by the microservice
      const files = [];

      if (serviceName === 'JPEG2AVIF') {
        // Handle JPEG2AVIF microservice response format (full-size only)
        if (!responseData.fullSize) {
          throw new Error(`Conversion failed (${serviceName}): Missing fullSize in response`);
        }

        // Generate filename based on original name
        const baseName = originalName.replace(/\.(jpg|jpeg)$/i, '');
        
        // Process full-size only
        files.push({
          filename: `${baseName}.avif`,
          content: responseData.fullSize.data, // Already base64 encoded
          size: responseData.fullSize.size,
          mimetype: 'image/avif',
          variant: 'full'
        });

        console.log(`[AVIF_CONVERTER] ${serviceName} processed: full-size (${responseData.fullSize.size}B)`);
      } else {
        // Handle existing HEIC converter response format (variants array)
        if (!responseData.variants || responseData.variants.length === 0) {
          throw new Error(`Conversion failed (${serviceName}): No variants returned from microservice`);
        }

        for (const variant of responseData.variants) {
          files.push({
            filename: variant.filename,
            content: variant.content, // Already base64 encoded
            size: variant.size,
            mimetype: variant.mimetype,
            variant: variant.variant
          });
        }

        console.log(`[AVIF_CONVERTER] ${serviceName} returned ${responseData.variants.length} variants for ${originalName}`);
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
   * @param {string} originalName - Original filename to determine which service to check
   * @returns {boolean} True if microservice is available
   */
  async isAvailable(originalName = '') {
    const isJPEG = /\.(jpg|jpeg)$/i.test(originalName);
    
    if (isJPEG && this.jpeg2avifUrl) {
      // Check JPEG2AVIF service for JPEG files
      const health = await this.checkJpeg2AvifHealth();
      return health.success;
    } else {
      // Check HEIC converter for HEIC files
      const health = await this.checkHealth();
      return health.success;
    }
  }
}

module.exports = AvifConverterService;
