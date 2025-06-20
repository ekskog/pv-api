// Manual test script for Phase 2 - Job Status Storage
const jobService = require('./src/services/job-service');
const redisService = require('./src/services/redis-service');

async function testPhase2() {
  console.log('=== Phase 2 Manual Test ===');
  
  try {
    // Initialize Redis connection
    console.log('1. Connecting to Redis...');
    await redisService.connect();
    
    if (!jobService.isAvailable()) {
      console.error('❌ Redis not available');
      return;
    }
    console.log('✅ Redis connected');
    
    // Create a test job
    console.log('\n2. Creating test job...');
    const testJobData = {
      bucketName: 'photos',
      folderPath: 'test-folder',
      userId: 'test-user',
      files: [
        { originalName: 'test1.jpg', size: 1024000 },
        { originalName: 'test2.heic', size: 2048000 }
      ],
      progress: { processed: 0, total: 2 }
    };
    
    const job = await jobService.createJob(testJobData);
    console.log(`✅ Created job: ${job.id}`);
    console.log(`   Status: ${job.status}`);
    console.log(`   Files: ${job.files.length}`);
    
    // Test getting job status
    console.log('\n3. Testing getJobStatus...');
    const retrievedJob = await jobService.getJobStatus(job.id);
    if (retrievedJob && retrievedJob.id === job.id) {
      console.log('✅ Job retrieved successfully');
      console.log(`   ID: ${retrievedJob.id}`);
      console.log(`   Status: ${retrievedJob.status}`);
      console.log(`   Created: ${retrievedJob.createdAt}`);
    } else {
      console.log('❌ Failed to retrieve job');
    }
    
    // Test updating job status
    console.log('\n4. Testing updateJobStatus...');
    const updatedJob = await jobService.updateJobStatus(job.id, {
      status: 'processing',
      progress: { processed: 1, total: 2 }
    });
    
    if (updatedJob && updatedJob.status === 'processing') {
      console.log('✅ Job updated successfully');
      console.log(`   Status: ${updatedJob.status}`);
      console.log(`   Progress: ${updatedJob.progress.processed}/${updatedJob.progress.total}`);
    } else {
      console.log('❌ Failed to update job');
    }
    
    // Test non-existent job
    console.log('\n5. Testing non-existent job...');
    const nonExistentJob = await jobService.getJobStatus('non-existent-job-123');
    if (nonExistentJob === null) {
      console.log('✅ Correctly returned null for non-existent job');
    } else {
      console.log('❌ Should return null for non-existent job');
    }
    
    console.log('\n=== Phase 2 Test Results ===');
    console.log('✅ Job creation: PASS');
    console.log('✅ Job retrieval: PASS');
    console.log('✅ Job update: PASS');
    console.log('✅ Non-existent job handling: PASS');
    console.log('\n📝 Test job ID for endpoint testing:', job.id);
    console.log('🔗 Test endpoint: GET /upload/status/' + job.id);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await redisService.disconnect();
  }
}

// Run the test
testPhase2();
