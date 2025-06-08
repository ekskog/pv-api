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
    console.log(`\n🔧 HEIC PROCESSOR: Starting HEIC processing for ${fileName}`);
    console.log(`📏 Input buffer size: ${heicBuffer.length} bytes`);
    
    if (!this.heicSupported) {
      throw new Error('HEIC processing not supported - please install libheif');
    }

    const baseName = path.parse(fileName).name;
    const results = {};

    try {
      console.log(`🔄 Converting HEIC to JPEG using heic-convert...`);
      // First convert HEIC to JPEG using heic-convert
      const jpegBuffer = await heicConvert({
        buffer: heicBuffer,
        format: 'JPEG',
        quality: 1 // Use maximum quality for initial conversion
      });

      console.log(`✅ HEIC to JPEG conversion complete - JPEG size: ${jpegBuffer.length} bytes`);

      // Then use Sharp to create variants from the JPEG
      const image = sharp(jpegBuffer);
      const metadata = await image.metadata();
      
      console.log(`📊 JPEG metadata:`);
      console.log(`   - Format: ${metadata.format}`);
      console.log(`   - Dimensions: ${metadata.width}x${metadata.height}`);
      console.log(`   - EXIF: ${metadata.exif ? 'Present' : 'None'}`);

      // Generate only full-size AVIF variant (per user requirements: no thumbnails, no originals)
      const variants = [
        {
          name: 'full',
          width: null, // Keep original dimensions
          height: null,
          quality: 90,
          format: 'avif'
        }
      ];

      console.log(`🎯 Creating ${variants.length} AVIF variants: ${variants.map(v => v.name).join(', ')}`);

      // Process each variant
      for (const variant of variants) {
        console.log(`\n🔧 Processing variant: ${variant.name} (${variant.quality}% quality)`);
        
        let processedBuffer;
        
        if (variant.name === 'full') {
          console.log(`   - Creating full-size AVIF (${metadata.width}x${metadata.height})`);
          // For full-size, just convert format without resizing, preserve metadata
          processedBuffer = await image
            .withMetadata() // Preserve EXIF metadata
            .heif({ quality: variant.quality, compression: 'av1' })
            .toBuffer();
        }

        const filename = `${baseName}_${variant.name}.${variant.format === 'avif' ? 'avif' : variant.format}`;
        const mimetype = `image/${variant.format === 'avif' ? 'avif' : variant.format}`;
        
        console.log(`✅ Variant ${variant.name} created:`);
        console.log(`   - Filename: ${filename}`);
        console.log(`   - Size: ${processedBuffer.length} bytes`);
        console.log(`   - MIME type: ${mimetype}`);
        console.log(`   - Compression: ${Math.round((processedBuffer.length / heicBuffer.length) * 100)}% of original HEIC`);

        results[variant.name] = {
          buffer: processedBuffer,
          filename: filename,
          size: processedBuffer.length,
          mimetype: mimetype,
          dimensions: variant.name === 'full' ? {
            width: metadata.width || 'unknown',
            height: metadata.height || 'unknown'
          } : {
            width: variant.width,
            height: variant.height
          }
        };
      }

      console.log(`\n🎉 HEIC PROCESSOR COMPLETE for ${fileName}:`);
      console.log(`   - Total variants created: ${Object.keys(results).length}`);
      console.log(`   - Variants: ${Object.keys(results).join(', ')}`);
      
      return results;

    } catch (error) {
      throw new Error(`HEIC processing failed: ${error.message}`);
    }
  }

  /**
   * Quick HEIC to AVIF conversion for immediate use
   * @param {Buffer} heicBuffer 
   * @param {Object} options 
   */
  async quickConvert(heicBuffer, options = {}) {
    const {
      quality = 85,
      maxWidth = 1200,
      maxHeight = 1200,
      format = 'avif' // Default to AVIF for better compression
    } = options;

    if (!this.heicSupported) {
      throw new Error('HEIC processing not supported');
    }

    // First convert HEIC to JPEG using heic-convert
    const jpegBuffer = await heicConvert({
      buffer: heicBuffer,
      format: 'JPEG',
      quality: 1 // Use maximum quality for intermediate conversion
    });

    // Then convert to desired format (AVIF/JPEG) and optionally resize with Sharp
    let sharpImage = sharp(jpegBuffer);
    
    if (maxWidth || maxHeight) {
      sharpImage = sharpImage.resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    if (format === 'avif') {
      return await sharpImage.heif({ quality, compression: 'av1' }).toBuffer();
    } else {
      return await sharpImage.jpeg({ quality }).toBuffer();
    }
  }

  /**
   * Convert any image buffer to AVIF (for testing and general use)
   * @param {Buffer} imageBuffer 
   * @param {Object} options 
   */
  async convertToAvif(imageBuffer, options = {}) {
    const {
      quality = 85,
      maxWidth = 1200,
      maxHeight = 1200
    } = options;

    let sharpImage = sharp(imageBuffer);
    
    if (maxWidth || maxHeight) {
      sharpImage = sharpImage.resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    return await sharpImage
      .withMetadata() // Preserve EXIF metadata
      .heif({ quality, compression: 'av1' })
      .toBuffer();
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
