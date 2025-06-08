#!/usr/bin/env node
// Test AVIF conversion with Sharp
const HeicProcessor = require('./heic-processor');
const fs = require('fs');
const path = require('path');

async function testAvifConversion() {
  console.log('🧪 Testing AVIF conversion capabilities...\n');
  
  const processor = new HeicProcessor();
  
  // Test 1: Check Sharp AVIF support
  console.log('1️⃣ Checking Sharp AVIF support...');
  const sharp = require('sharp');
  const formats = sharp.format;
  
  if (formats.avif && formats.avif.output) {
    console.log('✅ Sharp AVIF output support: ENABLED');
    console.log(`   - Quality support: ${formats.avif.output.quality ? 'YES' : 'NO'}`);
    console.log(`   - Lossless support: ${formats.avif.output.lossless ? 'YES' : 'NO'}`);
  } else {
    console.log('❌ Sharp AVIF output support: DISABLED');
    console.log('   You may need to update Sharp or install with AVIF support');
    return;
  }
  
  // Test 2: Create a small test image and convert to AVIF
  console.log('\n2️⃣ Testing AVIF creation from synthetic image...');
  try {
    const testBuffer = await sharp({
      create: {
        width: 300,
        height: 300,
        channels: 3,
        background: { r: 100, g: 150, b: 200 }
      }
    })
    .avif({ quality: 85 })
    .toBuffer();
    
    console.log('✅ AVIF creation: SUCCESS');
    console.log(`   - Generated ${testBuffer.length} bytes`);
    console.log(`   - Size reduction vs PNG: ~${Math.round((1 - testBuffer.length / (300 * 300 * 3)) * 100)}%`);
  } catch (error) {
    console.log('❌ AVIF creation: FAILED');
    console.log(`   Error: ${error.message}`);
    return;
  }
  
  // Test 3: Test file format detection
  console.log('\n3️⃣ Testing HEIC file detection...');
  const testFiles = [
    'IMG_1234.HEIC',
    'photo.heic', 
    'image.HEIF',
    'test.jpg',
    'normal.png'
  ];
  
  testFiles.forEach(filename => {
    const isHeic = HeicProcessor.isHeicFile(filename);
    console.log(`   ${filename}: ${isHeic ? '✅ HEIC' : '❌ Not HEIC'}`);
  });
  
  // Test 4: Look for sample HEIC files in current directory
  console.log('\n4️⃣ Looking for HEIC files to test with...');
  const currentDir = process.cwd();
  const files = fs.readdirSync(currentDir);
  const heicFiles = files.filter(file => HeicProcessor.isHeicFile(file));
  
  if (heicFiles.length > 0) {
    console.log(`✅ Found ${heicFiles.length} HEIC file(s):`);
    heicFiles.forEach(file => console.log(`   - ${file}`));
    
    // Test actual HEIC conversion if files exist
    const testFile = heicFiles[0];
    console.log(`\n5️⃣ Testing HEIC → AVIF conversion with ${testFile}...`);
    
    try {
      const heicBuffer = fs.readFileSync(testFile);
      console.log(`   - Input file size: ${heicBuffer.length} bytes`);
      
      const results = await processor.processHeicFile(heicBuffer, testFile);
      
      console.log('✅ HEIC processing: SUCCESS');
      console.log('   Generated variants:');
      
      Object.entries(results).forEach(([variantName, variantData]) => {
        if (variantName !== 'original') {
          const compressionRatio = Math.round((1 - variantData.size / heicBuffer.length) * 100);
          console.log(`   - ${variantName}: ${variantData.filename}`);
          console.log(`     Size: ${variantData.size} bytes (${compressionRatio}% compression)`);
          console.log(`     Format: ${variantData.mimetype}`);
          console.log(`     Dimensions: ${variantData.dimensions.width}x${variantData.dimensions.height}`);
        }
      });
      
      // Save test outputs
      console.log('\n💾 Saving test outputs...');
      Object.entries(results).forEach(([variantName, variantData]) => {
        if (variantName !== 'original') {
          const outputPath = `test_output_${variantData.filename}`;
          fs.writeFileSync(outputPath, variantData.buffer);
          console.log(`   - Saved: ${outputPath}`);
        }
      });
      
    } catch (error) {
      console.log('❌ HEIC processing: FAILED');
      console.log(`   Error: ${error.message}`);
    }
  } else {
    console.log('ℹ️  No HEIC files found in current directory');
    console.log('   To test with real files, place some HEIC files in:');
    console.log(`   ${currentDir}`);
  }
  
  console.log('\n🎉 AVIF conversion test completed!');
  console.log('\nNext steps:');
  console.log('1. If all tests passed, AVIF conversion is ready');
  console.log('2. Deploy updated API with AVIF support');
  console.log('3. Update frontend to use AVIF URLs');
  console.log('4. Remove client-side HEIC conversion code');
}

// Run the test
testAvifConversion().catch(error => {
  console.error('💥 Test failed:', error);
  process.exit(1);
});
