// HEIC Processing Module for PhotoVault API
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const fs = require('fs');
const path = require('path');

class HeicProcessor {
  constructor() {
    // Use heic-convert library which has better HEIC codec support
    this.heicSupported = true; // heic-convert always works
  }

  /**
   * Process HEIC file and generate multiple formats/sizes
   * @param {Buffer} heicBuffer - Original HEIC file buffer
   * @param {string} fileName - Original filename
   * @returns {Object} Processed variants
   */
  async processHeicFile(heicBuffer, fileName) {
    if (!this.heicSupported) {
      throw new Error('HEIC processing not supported - please install libheif');
    }

    const baseName = path.parse(fileName).name;
    const results = {};

    try {
      // First convert HEIC to JPEG using heic-convert
      const jpegBuffer = await heicConvert({
        buffer: heicBuffer,
        format: 'JPEG',
        quality: 1 // Use maximum quality for initial conversion
      });

      // Then use Sharp to create variants from the JPEG
      const image = sharp(jpegBuffer);
      const metadata = await image.metadata();

      // Generate only thumbnail for grid view - keep it simple!
      const variants = [
        {
          name: 'thumbnail',
          width: 300,
          height: 300,
          quality: 80,
          format: 'jpeg'
        }
      ];

      // Process each variant
      for (const variant of variants) {
        const processedBuffer = await image
          .resize(variant.width, variant.height, {
            fit: 'inside',
            withoutEnlargement: true
          })
          .toFormat(variant.format, { quality: variant.quality })
          .toBuffer();

        results[variant.name] = {
          buffer: processedBuffer,
          filename: `${baseName}_${variant.name}.${variant.format}`,
          size: processedBuffer.length,
          mimetype: `image/${variant.format}`,
          dimensions: {
            width: variant.width,
            height: variant.height
          }
        };
      }

      // Also keep the original HEIC for archival
      results.original = {
        buffer: heicBuffer,
        filename: fileName,
        size: heicBuffer.length,
        mimetype: 'image/heic',
        dimensions: {
          width: metadata.width || 'unknown',
          height: metadata.height || 'unknown'
        }
      };

      return results;

    } catch (error) {
      throw new Error(`HEIC processing failed: ${error.message}`);
    }
  }

  /**
   * Quick HEIC to JPEG conversion for immediate use
   * @param {Buffer} heicBuffer 
   * @param {Object} options 
   */
  async quickConvert(heicBuffer, options = {}) {
    const {
      quality = 85,
      maxWidth = 1200,
      maxHeight = 1200
    } = options;

    if (!this.heicSupported) {
      throw new Error('HEIC processing not supported');
    }

    // First convert HEIC to JPEG using heic-convert
    const jpegBuffer = await heicConvert({
      buffer: heicBuffer,
      format: 'JPEG',
      quality: quality / 100 // heic-convert expects 0-1 range
    });

    // Then optionally resize with Sharp
    if (maxWidth || maxHeight) {
      return await sharp(jpegBuffer)
        .resize(maxWidth, maxHeight, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality })
        .toBuffer();
    }

    return jpegBuffer;
  }

  /**
   * Check if file is HEIC format
   */
  static isHeicFile(filename) {
    return /\.(heic|heif)$/i.test(filename);
  }

  /**
   * Get Sharp installation instructions
   */
  static getInstallInstructions() {
    return `
To enable HEIC processing, install Sharp with HEIC support:

npm uninstall sharp
npm install --platform=darwin --arch=x64 sharp
# or for Linux:
# npm install --platform=linux --arch=x64 sharp

For production, you may also need:
sudo apt-get install libheif-dev  # Ubuntu/Debian
# or
brew install libheif  # macOS
    `;
  }
}

module.exports = HeicProcessor;
