const fs = require('fs');
const path = require('path');
const UploadService = require('./services/upload-service');
const HeicProcessor = require('./heic-processor');

// Mock MinIO client for testing
const mockMinioClient = {
  putObject: async (bucket, objectName, buffer, size, metadata) => {
    console.log(`📤 Mock upload: ${objectName} (${size} bytes)`);
    console.log(`   Metadata:`, Object.keys(metadata));
    return {
      etag: 'mock-etag-' + Date.now(),
      versionId: null
    };
  }
};

async function testAvifUploadService() {
  console.log('🧪 Testing AVIF Upload Service...\n');
  
  const uploadService = new UploadService(mockMinioClient);
  const sharp = require('sharp');
  
  try {
    // Test 1: Create a mock JPEG file
    console.log('📸 Creating test JPEG image...');
    const jpegBuffer = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 150, g: 100, b: 200 }
      }
    })
    .jpeg({ quality: 90 })
    .toBuffer();
    
    const mockJpegFile = {
      originalname: 'test-photo.jpg',
      buffer: jpegBuffer,
      size: jpegBuffer.length,
      mimetype: 'image/jpeg'
    };
    
    console.log(`✅ Created test JPEG: ${jpegBuffer.length} bytes\n`);
    
    // Test 2: Process the JPEG file through upload service
    console.log('🔄 Processing JPEG through upload service...');
    const jpegResults = await uploadService.processAndUploadFile(
      mockJpegFile, 
      'test-bucket', 
      'test-folder'
    );
    
    console.log('✅ JPEG Processing Results:');
    jpegResults.forEach((result, index) => {
      console.log(`   ${index + 1}. ${result.objectName}`);
      console.log(`      Size: ${result.size} bytes`);
      console.log(`      Type: ${result.mimetype}`);
      console.log(`      Variant: ${result.variant || 'original'}`);
      if (result.convertedFrom) {
        console.log(`      Converted from: ${result.convertedFrom}`);
      }
    });
    
    // Test 3: Create a mock PNG file
    console.log('\n📸 Creating test PNG image...');
    const pngBuffer = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 4,
        background: { r: 200, g: 150, b: 100, alpha: 1 }
      }
    })
    .png()
    .toBuffer();
    
    const mockPngFile = {
      originalname: 'test-graphic.png',
      buffer: pngBuffer,
      size: pngBuffer.length,
      mimetype: 'image/png'
    };
    
    console.log(`✅ Created test PNG: ${pngBuffer.length} bytes\n`);
    
    // Test 4: Process the PNG file
    console.log('🔄 Processing PNG through upload service...');
    const pngResults = await uploadService.processAndUploadFile(
      mockPngFile, 
      'test-bucket', 
      'graphics'
    );
    
    console.log('✅ PNG Processing Results:');
    pngResults.forEach((result, index) => {
      console.log(`   ${index + 1}. ${result.objectName}`);
      console.log(`      Size: ${result.size} bytes`);
      console.log(`      Type: ${result.mimetype}`);
      console.log(`      Variant: ${result.variant || 'original'}`);
      if (result.convertedFrom) {
        console.log(`      Converted from: ${result.convertedFrom}`);
      }
    });
    
    // Test 5: Test non-image file (should not be converted)
    console.log('\n📄 Testing non-image file...');
    const textBuffer = Buffer.from('This is a test document', 'utf8');
    const mockTextFile = {
      originalname: 'document.txt',
      buffer: textBuffer,
      size: textBuffer.length,
      mimetype: 'text/plain'
    };
    
    const textResults = await uploadService.processAndUploadFile(
      mockTextFile, 
      'test-bucket', 
      'documents'
    );
    
    console.log('✅ Text File Results (should not be converted):');
    textResults.forEach((result, index) => {
      console.log(`   ${index + 1}. ${result.objectName}`);
      console.log(`      Size: ${result.size} bytes`);
      console.log(`      Type: ${result.mimetype}`);
    });
    
    // Test 6: Test batch processing
    console.log('\n🔄 Testing batch processing...');
    const batchResults = await uploadService.processMultipleFiles(
      [mockJpegFile, mockPngFile, mockTextFile], 
      'test-bucket', 
      'batch-test'
    );
    
    console.log('✅ Batch Processing Results:');
    console.log(`   Successful uploads: ${batchResults.results.length}`);
    console.log(`   Errors: ${batchResults.errors.length}`);
    
    if (batchResults.errors.length > 0) {
      console.log('   Errors:');
      batchResults.errors.forEach(error => {
        console.log(`     - ${error.filename}: ${error.error}`);
      });
    }
    
    // Calculate compression statistics
    console.log('\n📊 Compression Statistics:');
    
    const jpegOriginal = jpegResults.find(r => r.isOriginal);
    const jpegThumbnail = jpegResults.find(r => r.variant === 'thumbnail');
    const jpegFull = jpegResults.find(r => r.variant === 'full');
    
    if (jpegOriginal && jpegFull) {
      const compressionRatio = ((1 - jpegFull.size / jpegOriginal.size) * 100);
      console.log(`   JPEG → AVIF (full): ${compressionRatio.toFixed(1)}% smaller`);
    }
    
    if (jpegOriginal && jpegThumbnail) {
      const thumbnailRatio = ((1 - jpegThumbnail.size / jpegOriginal.size) * 100);
      console.log(`   JPEG → AVIF (thumbnail): ${thumbnailRatio.toFixed(1)}% smaller`);
    }
    
    console.log('\n🎉 All upload service tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('   Stack:', error.stack);
  }
}

// Run the test
testAvifUploadService().catch(console.error);
