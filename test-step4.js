#!/usr/bin/env node

const AvifConverterService = require('./src/services/avif-converter-service');
const sharp = require('sharp');

async function testStep4FormData() {
  console.log('='.repeat(60));
  console.log('STEP 4 TEST: FormData Communication Fix');
  console.log('='.repeat(60));
  
  const converterService = new AvifConverterService();
  
  // Test 1: Service Health Check
  console.log('\n📋 Test 1: Service Health Check');
  console.log('-'.repeat(30));
  
  const health = await converterService.checkHealth();
  if (!health.success) {
    console.log('❌ AVIF converter service is not available');
    console.log('   Make sure avif-converter is running: cd ../avif-converter && node api.js');
    return false;
  }
  console.log('✅ AVIF converter service is healthy');
  
  // Test 2: Create test image and convert
  console.log('\n📋 Test 2: Image Conversion with FormData');
  console.log('-'.repeat(30));
  
  try {
    // Create a simple test image
    const testImageBuffer = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 0, g: 255, b: 0 } // Green square
      }
    })
    .png()
    .toBuffer();
    
    console.log(`✅ Created test image: 200x200 green PNG (${(testImageBuffer.length / 1024).toFixed(2)}KB)`);
    
    // Test conversion
    console.log('📤 Sending image to avif-converter microservice...');
    const conversionResult = await converterService.convertImage(
      testImageBuffer,
      'test-step4.png',
      'image/png'
    );
    
    if (conversionResult.success) {
      console.log('✅ Conversion successful!');
      console.log('📝 Response data:', JSON.stringify(conversionResult.data, null, 2));
    } else {
      console.log('❌ Conversion failed:', conversionResult.error);
      return false;
    }
    
  } catch (error) {
    console.log('❌ FormData test failed:', error.message);
    return false;
  }
  
  console.log('\n✅ STEP 4 FORMDATA TEST COMPLETED!');
  console.log('\n📝 Next steps based on results:');
  console.log('   - If successful: Update upload service to handle real file data');
  console.log('   - If failed: Debug FormData compatibility issue');
  
  return true;
}

// Run the test
testStep4FormData().catch(error => {
  console.error('\n💥 Test failed with error:', error.message);
  process.exit(1);
});
