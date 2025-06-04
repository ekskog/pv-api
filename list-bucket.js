const Minio = require('minio');
require('dotenv').config();

// Initialize MinIO client
const minioClient = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT,
    port: parseInt(process.env.MINIO_PORT),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY
});

async function listBucketContents(bucketName, prefix = '') {
    try {
        console.log(`\n📁 Listing contents of bucket: ${bucketName}`);
        if (prefix) {
            console.log(`   With prefix: ${prefix}`);
        }
        console.log('─'.repeat(80));

        const objectsStream = minioClient.listObjects(bucketName, prefix, true);
        let objectCount = 0;

        for await (const obj of objectsStream) {
            objectCount++;
            const size = (obj.size / 1024).toFixed(2);
            const lastModified = obj.lastModified.toISOString().split('T')[0];
            console.log(`📄 ${obj.name}`);
            console.log(`   Size: ${size} KB | Modified: ${lastModified}`);
            console.log('');
        }

        if (objectCount === 0) {
            console.log('   (Empty or no objects found)');
        } else {
            console.log(`\n📊 Total objects: ${objectCount}`);
        }
        
    } catch (error) {
        console.error('Error listing bucket contents:', error.message);
    }
}

// List photovault bucket contents
listBucketContents('photovault');
