// Manual test script for Phase 3 - Real file upload with auth
const fs = require('fs');
const path = require('path');
const os = require('os');

// Base API URL
const API_BASE_URL = 'https://vault-api.hbvu.su';

async function testManualUpload() {
  console.log('=== Phase 3 Manual Upload Test ===');
  
  try {
    // Step 1: Get authentication token
    console.log('1. Getting authentication token...');
    
    const loginResponse = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: 'demo',
        password: 'demo123'
      })
    });
    
    if (!loginResponse.ok) {
      throw new Error(`Login failed: ${loginResponse.status} ${loginResponse.statusText}`);
    }
    
    const loginData = await loginResponse.json();
    if (!loginData.success || !loginData.data.token) {
      throw new Error('Login failed: No token received');
    }
    
    const authToken = loginData.data.token;
    console.log('✅ Authentication successful');
    console.log(`   User: ${loginData.data.user.username} (${loginData.data.user.role})`);
    console.log(`   Token: ${authToken.substring(0, 20)}...`);
    
    // Step 2: Find a JPEG file in Downloads folder
    console.log('\n2. Looking for JPEG files in Downloads folder...');
    
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    console.log(`   Searching in: ${downloadsPath}`);
    
    if (!fs.existsSync(downloadsPath)) {
      throw new Error('Downloads folder not found');
    }
    
    const files = fs.readdirSync(downloadsPath);
    const jpegFiles = files.filter(file => 
      /\.(jpg|jpeg)$/i.test(file) && 
      fs.statSync(path.join(downloadsPath, file)).isFile()
    );
    
    if (jpegFiles.length === 0) {
      throw new Error('No JPEG files found in Downloads folder');
    }
    
    // Use the first JPEG file found
    const selectedFile = jpegFiles[0];
    const filePath = path.join(downloadsPath, selectedFile);
    const fileStats = fs.statSync(filePath);
    
    console.log(`✅ Found JPEG file: ${selectedFile}`);
    console.log(`   Size: ${(fileStats.size / 1024 / 1024).toFixed(2)}MB`);
    console.log(`   Path: ${filePath}`);
    
    // Step 3: Create FormData and upload
    console.log('\n3. Uploading file to clean-test folder...');
    
    const fileBuffer = fs.readFileSync(filePath);
    const formData = new FormData();
    
    // Create a Blob from the buffer
    const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
    formData.append('files', blob, selectedFile);
    formData.append('folderPath', 'clean-test');
    
    console.log(`   Uploading: ${selectedFile} -> photos/clean-test/`);
    console.log(`   File size: ${fileBuffer.length} bytes`);
    
    const uploadResponse = await fetch(`${API_BASE_URL}/buckets/photos/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      body: formData
    });
    
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}\n${errorText}`);
    }
    
    const uploadData = await uploadResponse.json();
    console.log('✅ Upload response received');
    console.log(`   Success: ${uploadData.success}`);
    
    if (uploadData.success) {
      console.log(`   Uploaded files: ${uploadData.data.uploadedCount}/${uploadData.data.totalFiles}`);
      console.log(`   Folder: ${uploadData.data.folderPath}`);
      
      // Step 4: Check if we got a job ID (async processing)
      if (uploadData.data.jobId) {
        console.log(`   Job ID: ${uploadData.data.jobId}`);
        console.log('\n4. Monitoring job status...');
        
        await monitorJobStatus(uploadData.data.jobId, authToken);
      } else {
        console.log('\n4. Direct upload completed (no async job)');
        if (uploadData.data.uploaded && uploadData.data.uploaded.length > 0) {
          console.log('   Uploaded variants:');
          uploadData.data.uploaded.forEach((file, index) => {
            console.log(`     ${index + 1}. ${file.objectName} (${file.variant || 'original'}) - ${(file.size / 1024).toFixed(2)}KB`);
          });
        }
      }
    } else {
      console.error('❌ Upload failed:', uploadData.error);
      if (uploadData.errors) {
        uploadData.errors.forEach(error => {
          console.error(`   - ${error.filename}: ${error.error}`);
        });
      }
    }
    
    console.log('\n=== Manual Upload Test Complete ===');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
  }
}

// Monitor job status with polling
async function monitorJobStatus(jobId, authToken) {
  const maxAttempts = 30; // 1 minute total
  const intervalMs = 2000; // 2 seconds
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const statusResponse = await fetch(`${API_BASE_URL}/upload/status/${jobId}`, {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });
      
      if (!statusResponse.ok) {
        throw new Error(`Status check failed: ${statusResponse.status}`);
      }
      
      const statusData = await statusResponse.json();
      
      if (statusData.success && statusData.data) {
        const job = statusData.data;
        console.log(`   [${attempt}/${maxAttempts}] Status: ${job.status} (${job.progress.processed}/${job.progress.total})`);
        
        if (job.status === 'completed') {
          console.log('✅ Job completed successfully!');
          if (job.results && job.results.length > 0) {
            console.log('   Final results:');
            job.results.forEach((file, index) => {
              console.log(`     ${index + 1}. ${file.objectName} (${file.variant || 'original'}) - ${(file.size / 1024).toFixed(2)}KB`);
            });
          }
          return;
        } else if (job.status === 'failed') {
          console.error('❌ Job failed!');
          if (job.errors && job.errors.length > 0) {
            job.errors.forEach(error => {
              console.error(`   - ${error.filename}: ${error.error}`);
            });
          }
          return;
        }
        
        // Continue polling if still processing
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
      } else {
        throw new Error('Invalid status response');
      }
    } catch (error) {
      console.error(`   [${attempt}/${maxAttempts}] Status check error: ${error.message}`);
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
  }
  
  console.error('❌ Job monitoring timeout - final status unknown');
}

// Run the test
testManualUpload();
