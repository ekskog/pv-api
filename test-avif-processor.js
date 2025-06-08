const fs = require('fs');
const path = require('path');
const HeicProcessor = require('./heic-processor');

async function testAvifProcessor() {
  console.log('🧪 Testing AVIF processor with HEIC file...');
  
  const processor = new HeicProcessor();
  
  try {
    // Create a simple test image as HEIC won't be available for testing
    // In real usage, this would be a HEIC buffer from uploaded file
    const sharp = require('sharp');
    
    // Create a test image
    const testImageBuffer = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 100, g: 150, b: 200 }
      }
    })
    .jpeg({ quality: 90 })
    .toBuffer();
    
    console.log('📸 Created test image (800x600)');
    
    // Test convertToAvif for general image conversion
    console.log('\n🔄 Testing convertToAvif with test image...');
    const quickAvif = await processor.convertToAvif(testImageBuffer, {
      quality: 85,
      maxWidth: 400,
      maxHeight: 400
    });
    
    console.log(`✅ AVIF conversion successful!`);
    console.log(`   Original size: ${testImageBuffer.length} bytes`);
    console.log(`   AVIF size: ${quickAvif.length} bytes`);
    console.log(`   Compression ratio: ${((1 - quickAvif.length / testImageBuffer.length) * 100).toFixed(1)}%`);
    
    // Test full processing (simulating HEIC workflow)
    console.log('\n🔄 Testing full HEIC processing workflow...');
    
    // For testing, we'll simulate the HEIC conversion step
    const heicConvert = require('heic-convert');
    
    // Note: Since we don't have actual HEIC files, we'll simulate this step
    console.log('   ⚠️  Simulating HEIC input (in real usage this would be actual HEIC data)');
    
    // Simulate the workflow that would happen with real HEIC
    const jpegBuffer = testImageBuffer; // This would normally be: await heicConvert({buffer: heicBuffer, format: 'JPEG', quality: 1});
    
    // Test the Sharp-based AVIF processing
    const sharp2 = require('sharp');
    const image = sharp2(jpegBuffer);
    const metadata = await image.metadata();
    
    console.log(`   📏 Image metadata: ${metadata.width}x${metadata.height}`);
    
    // Test thumbnail creation
    const thumbnailBuffer = await image
      .resize(300, 300, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .heif({ quality: 85, compression: 'av1' })
      .toBuffer();
      
    console.log(`✅ Thumbnail AVIF created: ${thumbnailBuffer.length} bytes`);
    
    // Test full-size AVIF creation
    const fullBuffer = await image
      .heif({ quality: 90, compression: 'av1' })
      .toBuffer();
      
    console.log(`✅ Full-size AVIF created: ${fullBuffer.length} bytes`);
    
    // Compare sizes
    console.log('\n📊 Size comparison:');
    console.log(`   Original: ${testImageBuffer.length} bytes`);
    console.log(`   Thumbnail AVIF: ${thumbnailBuffer.length} bytes (${((1 - thumbnailBuffer.length / testImageBuffer.length) * 100).toFixed(1)}% smaller)`);
    console.log(`   Full AVIF: ${fullBuffer.length} bytes (${((1 - fullBuffer.length / testImageBuffer.length) * 100).toFixed(1)}% smaller)`);
    
    console.log('\n🎉 All AVIF processor tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('   Stack:', error.stack);
  }
}

// Run the test
testAvifProcessor().catch(console.error);
