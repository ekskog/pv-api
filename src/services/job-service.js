// Job Service - Handles upload job status storage and retrieval
const { v4: uuidv4 } = require('uuid');
const redisService = require('./redis-service');

class JobService {
  constructor() {
    this.keyPrefix = 'job:';
  }

  /**
   * Create a new upload job
   * @param {Object} jobData - Job data
   * @returns {Object} Created job with ID
   */
  async createJob(jobData) {
    const jobId = uuidv4();
    const job = {
      id: jobId,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...jobData
    };

    if (!redisService.isConnected()) {
      throw new Error('Redis not connected - cannot create job');
    }

    try {
      const client = redisService.getClient();
      await client.setEx(
        `${this.keyPrefix}${jobId}`,
        86400, // 24 hours expiry
        JSON.stringify(job)
      );
      
      console.log(`[JOB] Created job ${jobId} with status: ${job.status}`);
      return job;
    } catch (error) {
      console.error(`[JOB] Failed to create job:`, error.message);
      throw new Error(`Failed to create job: ${error.message}`);
    }
  }

  /**
   * Get job status by ID
   * @param {string} jobId - Job ID
   * @returns {Object|null} Job data or null if not found
   */
  async getJobStatus(jobId) {
    if (!redisService.isConnected()) {
      throw new Error('Redis not connected - cannot get job status');
    }

    try {
      const client = redisService.getClient();
      const jobData = await client.get(`${this.keyPrefix}${jobId}`);
      
      if (!jobData) {
        return null;
      }

      const job = JSON.parse(jobData);
      //console.log(`[JOB] Retrieved job ${jobId} with status: ${job.status}`);
      return job;
    } catch (error) {
      console.error(`[JOB] Failed to get job ${jobId}:`, error.message);
      throw new Error(`Failed to get job status: ${error.message}`);
    }
  }

  /**
   * Update job status and data
   * @param {string} jobId - Job ID
   * @param {Object} updates - Updates to apply
   * @returns {Object|null} Updated job or null if not found
   */
  async updateJobStatus(jobId, updates) {
    if (!redisService.isConnected()) {
      throw new Error('Redis not connected - cannot update job');
    }

    try {
      const client = redisService.getClient();
      const existingJobData = await client.get(`${this.keyPrefix}${jobId}`);
      
      if (!existingJobData) {
        return null;
      }

      const existingJob = JSON.parse(existingJobData);
      const updatedJob = {
        ...existingJob,
        ...updates,
        updatedAt: new Date().toISOString()
      };

      await client.setEx(
        `${this.keyPrefix}${jobId}`,
        86400, // 24 hours expiry
        JSON.stringify(updatedJob)
      );

      console.log(`[JOB] Updated job ${jobId}: ${existingJob.status} -> ${updatedJob.status}`);
      return updatedJob;
    } catch (error) {
      console.error(`[JOB] Failed to update job ${jobId}:`, error.message);
      throw new Error(`Failed to update job: ${error.message}`);
    }
  }

  /**
   * Delete a job
   * @param {string} jobId - Job ID
   * @returns {boolean} True if deleted, false if not found
   */
  async deleteJob(jobId) {
    if (!redisService.isConnected()) {
      throw new Error('Redis not connected - cannot delete job');
    }

    try {
      const client = redisService.getClient();
      const deleted = await client.del(`${this.keyPrefix}${jobId}`);
      
      console.log(`[JOB] ${deleted ? 'Deleted' : 'Not found'} job ${jobId}`);
      return deleted > 0;
    } catch (error) {
      console.error(`[JOB] Failed to delete job ${jobId}:`, error.message);
      throw new Error(`Failed to delete job: ${error.message}`);
    }
  }

  /**
   * Get Redis connection status for health checks
   */
  isAvailable() {
    return redisService.isConnected();
  }
}

// Create singleton instance
const jobService = new JobService();

module.exports = jobService;
