#!/usr/bin/env node

async function testPhotovaultApiConversion() {
  try {
    console.log('🧪 Testing PhotoVault API → AVIF Converter integration...');
    
    // Create a simple 1x1 pixel JPEG for testing
    const minimalJpegBase64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/wA==';
    
    const testJpegBuffer = Buffer.from(minimalJpegBase64, 'base64');
    const testFilename = 'test-image.jpg';
    
    console.log(`📤 Uploading test JPEG to PhotoVault API: ${testFilename} (${testJpegBuffer.length} bytes)`);
    
    // Create FormData for the photovault-api upload endpoint
    const formData = new FormData();
    const blob = new Blob([testJpegBuffer], { type: 'image/jpeg' });
    formData.append('image', blob, testFilename);
    
    // Use the convert-test endpoint which is designed for testing
    const apiUrl = 'http://localhost:3001';
    
    const response = await fetch(`${apiUrl}/convert-test`, {
      method: 'POST',
      body: formData
    });
    
    console.log(`📡 Response status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    
    console.log('✅ PhotoVault API Response:');
    console.log(JSON.stringify(result, null, 2));
    
    console.log('🎉 Integration test completed!');
    
  } catch (error) {
    console.error('❌ Integration test failed:', error.message);
  }
}

testPhotovaultApiConversion();
