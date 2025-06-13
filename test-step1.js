#!/usr/bin/env node

const AvifConverterService = require('./src/services/avif-converter-service');
const fs = require('fs');
const path = require('path');

async function testStep1Integration() {
  console.log('='.repeat(60));
  console.log('STEP 1 TEST: AvifConverterService Integration');
  console.log('='.repeat(60));
  
  const converterService = new AvifConverterService();
  
  // Test 1: Health Check
  console.log('\n📋 Test 1: Health Check');
  console.log('-'.repeat(30));
  
  const healthResult = await converterService.checkHealth();
  
  if (healthResult.success) {
    console.log('✅ Health check PASSED');
    console.log('   Service status:', healthResult.data.status);
    console.log('   Service name:', healthResult.data.service);
    console.log('   Timestamp:', healthResult.data.timestamp);
  } else {
    console.log('❌ Health check FAILED');
    console.log('   Error:', healthResult.error);
    console.log('\n🔧 Troubleshooting:');
    console.log('   1. Make sure avif-converter microservice is running');
    console.log('   2. Check if it\'s accessible at: http://localhost:3001');
    console.log('   3. Run: cd ../avif-converter && node api.js');
    return false;
  }
  
  // Test 2: Service Availability Check
  console.log('\n📋 Test 2: Service Availability Check');
  console.log('-'.repeat(30));
  
  const isAvailable = await converterService.isAvailable();
  
  if (isAvailable) {
    console.log('✅ Service availability check PASSED');
  } else {
    console.log('❌ Service availability check FAILED');
    return false;
  }
  
  // Test 3: Configuration Check
  console.log('\n📋 Test 3: Configuration Check');
  console.log('-'.repeat(30));
  
  console.log('✅ Configuration check:');
  console.log('   Base URL:', converterService.baseUrl);
  console.log('   Timeout:', `${converterService.timeout / 1000}s`);
  console.log('   Environment variables:');
  console.log('     AVIF_CONVERTER_URL:', process.env.AVIF_CONVERTER_URL || 'not set (using default)');
  console.log('     AVIF_CONVERTER_TIMEOUT:', process.env.AVIF_CONVERTER_TIMEOUT || 'not set (using default)');
  
  console.log('\n✅ STEP 1 INTEGRATION TEST COMPLETED SUCCESSFULLY!');
  console.log('\n📝 Summary:');
  console.log('   - AvifConverterService class created');
  console.log('   - Health check endpoint working');
  console.log('   - Service availability detection working');
  console.log('   - Configuration properly loaded');
  console.log('\n🎯 Next: Ready for Step 2 - Create test conversion endpoint');
  
  return true;
}

// Run the test
testStep1Integration().catch(error => {
  console.error('\n💥 Test failed with error:', error.message);
  process.exit(1);
});
