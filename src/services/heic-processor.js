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
    const timerLabel = `HEIC-${fileName}`;
    console.time(timerLabel);
    console.log(`[HEIC_PROCESSOR] Starting HEIC processing for file: ${fileName} (${(heicBuffer.length / 1024 / 1024).toFixed(2)}MB)`)
    
    // Check file size limit to prevent memory issues
    const maxSizeMB = 100; // 100MB limit
    const fileSizeMB = heicBuffer.length / 1024 / 1024;
    if (fileSizeMB > maxSizeMB) {
      console.error(`[HEIC_PROCESSOR] File too large: ${fileName} (${fileSizeMB.toFixed(2)}MB > ${maxSizeMB}MB)`)
      throw new Error(`File too large: ${fileSizeMB.toFixed(2)}MB. Maximum allowed: ${maxSizeMB}MB`);
    }
    
    if (!this.heicSupported) {
      console.error(`[HEIC_PROCESSOR] HEIC processing not supported for: ${fileName}`)
      throw new Error('HEIC processing not supported - please install libheif');
    }

    const baseName = path.parse(fileName).name;
    const results = {};

    try {
      // First convert HEIC to JPEG using heic-convert with timeout
      const heicConvertTimer = `HEIC-to-JPEG-${fileName}`;
      console.time(heicConvertTimer);
      console.log(`[HEIC_PROCESSOR] Converting HEIC to JPEG intermediate format: ${fileName}`)
      const jpegBuffer = await Promise.race([
        heicConvert({
          buffer: heicBuffer,
          format: 'JPEG',
          quality: 1 // Use maximum quality for initial conversion
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('HEIC conversion timeout')), 120000)) // 2 minutes timeout
      ]);
      console.timeEnd(heicConvertTimer);
      console.log(`[HEIC_PROCESSOR] HEIC to JPEG conversion completed: ${(jpegBuffer.length / 1024 / 1024).toFixed(2)}MB`)

      // Then use Sharp to create variants from the JPEG
      console.log(`[HEIC_PROCESSOR] Extracting metadata from converted JPEG`)
      const image = sharp(jpegBuffer);
      const metadata = await image.metadata();
      console.log(`[HEIC_PROCESSOR] Metadata extracted - Dimensions: ${metadata.width}x${metadata.height}, Format: ${metadata.format}`)

      // Generate full-size AVIF and thumbnail variants
      const variants = [
        {
          name: 'full',
          width: null, // Keep original dimensions
          height: null,
          quality: 90,
          format: 'avif'
        },
        {
          name: 'thumbnail',
          width: 300,
          height: 300,
          quality: 80,
          format: 'avif'
        }
      ];

      // Process each variant with timeout protection
      for (const variant of variants) {
        const variantTimer = `${variant.name}-variant-${fileName}`;
        console.time(variantTimer);
        console.log(`[HEIC_PROCESSOR] Creating ${variant.name} variant`)
        let processedBuffer;
        
        try {
          if (variant.name === 'full') {
            // For full-size, just convert format without resizing, preserve metadata
            processedBuffer = await Promise.race([
              image
                .rotate() // Auto-rotate based on EXIF orientation data
                .withMetadata() // Preserve EXIF metadata
                .heif({ quality: variant.quality, compression: 'av1' })
                .toBuffer(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Sharp processing timeout')), 180000)) // 3 minutes timeout
            ]);
          } else if (variant.name === 'thumbnail') {
            // For thumbnail, resize and convert
            processedBuffer = await Promise.race([
              image
                .rotate() // Auto-rotate based on EXIF orientation data
                .resize(variant.width, variant.height, { 
                  fit: 'cover', 
                  position: 'center' 
                })
                .heif({ quality: variant.quality, compression: 'av1' })
                .toBuffer(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Sharp processing timeout')), 60000)) // 1 minute timeout for thumbnails
            ]);
          }
          console.timeEnd(variantTimer);
        } catch (variantError) {
          console.timeEnd(variantTimer);
          console.error(`[HEIC_PROCESSOR] Failed to create ${variant.name} variant for ${fileName}:`, variantError.message)
          continue; // Skip this variant but continue with others
        }

        const filename = `${baseName}_${variant.name}.${variant.format === 'avif' ? 'avif' : variant.format}`;
        const mimetype = `image/${variant.format === 'avif' ? 'avif' : variant.format}`;
        console.log(`[HEIC_PROCESSOR] Generated ${variant.name}: ${filename} (${(processedBuffer.length / 1024).toFixed(2)}KB)`)

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
      
      console.timeEnd(timerLabel);
      console.log(`[HEIC_PROCESSOR] HEIC processing completed: ${Object.keys(results).length} variants created`)
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        console.log(`[HEIC_PROCESSOR] Garbage collection triggered after processing ${fileName}`)
      }
      
      return results;

    } catch (error) {
      console.timeEnd(timerLabel);
      console.error(`[HEIC_PROCESSOR] HEIC processing failed:`, error.message)
      
      // Force garbage collection on error
      if (global.gc) {
        global.gc();
      }
      
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
