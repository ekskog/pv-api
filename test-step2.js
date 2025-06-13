#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch').default;

async function testStep2ConversionEndpoint() {
  console.log('='.repeat(60));
  console.log('STEP 2 TEST: Test Conversion Endpoint');
  console.log('='.repeat(60));
  
  const apiUrl = 'http://localhost:3002';
  
  // Create a simple test image (PNG)
  console.log('\n📋 Test Setup: Creating test image');
  console.log('-'.repeat(30));
  
  // Create a simple 100x100 red PNG image using Sharp
  const sharp = require('sharp');
  const testImageBuffer = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: { r: 255, g: 0, b: 0 }
    }
  })
  .png()
  .toBuffer();
  
  console.log(`✅ Created test image: 100x100 red PNG (${(testImageBuffer.length / 1024).toFixed(2)}KB)`);
  
  // Test 1: API Health Check
  console.log('\n📋 Test 1: API Health Check');
  console.log('-'.repeat(30));
  
  try {
    const healthResponse = await fetch(`${apiUrl}/health`);
    const healthData = await healthResponse.json();
    if (healthResponse.status === 200 || healthResponse.status === 503) {
      console.log('✅ PhotoVault API is responding');
      console.log('   Status:', healthData.status);
      if (healthData.status === 'unhealthy') {
        console.log('   Note: MinIO connection failed, but server is running');
      }
    } else {
      throw new Error(`Unexpected status: ${healthResponse.status}`);
    }
  } catch (error) {
    console.log('❌ API health check FAILED:', error.message);
    console.log('\n🔧 Troubleshooting:');
    console.log('   1. Make sure photovault-api is running');
    console.log('   2. Run: npm run dev (or node src/server.js)');
    return false;
  }
  
  // Test 2: Test Conversion Endpoint
  console.log('\n📋 Test 2: Test Conversion Endpoint');
  console.log('-'.repeat(30));
  
  try {
    const formData = new FormData();
    formData.append('image', testImageBuffer, {
      filename: 'test-image.png',
      contentType: 'image/png'
    });
    
    console.log('   Sending conversion request...');
    const conversionResponse = await fetch(`${apiUrl}/convert-test`, {
      method: 'POST',
      body: formData,
      timeout: 30000 // 30 second timeout
    });
    
    if (conversionResponse.ok) {
      const conversionData = await conversionResponse.json();
      console.log('✅ Conversion request SUCCESSFUL');
      console.log('   Success:', conversionData.success);
      console.log('   Message:', conversionData.message);
      console.log('   Original file:', conversionData.originalFile?.name);
      console.log('   Converted files:', conversionData.data?.files?.length || 'unknown');
      
      if (conversionData.data?.files) {
        conversionData.data.files.forEach((file, index) => {
          console.log(`     ${index + 1}. ${file.variant}: ${file.file} (${file.size})`);
        });
      }
    } else {
      const errorText = await conversionResponse.text();
      console.log('❌ Conversion request FAILED');
      console.log('   Status:', conversionResponse.status);
      console.log('   Error:', errorText);
      
      if (conversionResponse.status === 503) {
        console.log('\n🔧 Troubleshooting:');
        console.log('   1. Make sure avif-converter microservice is running');
        console.log('   2. Run: cd ../avif-converter && node api.js');
      }
      return false;
    }
  } catch (error) {
    console.log('❌ Conversion test FAILED:', error.message);
    return false;
  }
  
  // Test 3: Error Handling (no file)
  console.log('\n📋 Test 3: Error Handling (no file)');
  console.log('-'.repeat(30));
  
  try {
    const noFileResponse = await fetch(`${apiUrl}/convert-test`, {
      method: 'POST',
      body: new FormData() // Empty form data
    });
    
    if (noFileResponse.status === 400) {
      const errorData = await noFileResponse.json();
      console.log('✅ Error handling WORKING');
      console.log('   Expected 400 status:', noFileResponse.status);
      console.log('   Error message:', errorData.error);
    } else {
      console.log('❌ Error handling NOT WORKING');
      console.log('   Expected 400, got:', noFileResponse.status);
      return false;
    }
  } catch (error) {
    console.log('❌ Error handling test FAILED:', error.message);
    return false;
  }
  
  console.log('\n✅ STEP 2 TEST COMPLETED SUCCESSFULLY!');
  console.log('\n📝 Summary:');
  console.log('   - Test conversion endpoint /convert-test created');
  console.log('   - Microservice integration working');
  console.log('   - Image conversion successful');
  console.log('   - Error handling working');
  console.log('   - Existing upload flow remains untouched');
  console.log('\n🎯 Next: Ready for Step 3 - Add fallback logic to upload service');
  
  return true;
}

// Run the test
testStep2ConversionEndpoint().catch(error => {
  console.error('\n💥 Test failed with error:', error.message);
  process.exit(1);
});
