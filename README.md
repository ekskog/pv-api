# PhotoVault API

A Node.js Express API for managing photo storage with MinIO backend.

## Features

- 🗂️ Bucket management (list, create)
- 📁 Folder operations (create, delete, list)
- 🔐 MinIO S3-compatible storage
- 🐳 Docker containerized
- ☸️ Kubernetes ready
- 🚀 CI/CD with GitHub Actions

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Test the API
curl http://localhost:3001/health
```

## API Endpoints

- `GET /health` - Health check
- `GET /buckets` - List all buckets
- `POST /buckets` - Create a bucket
- `GET /buckets/:bucket/objects` - List objects in bucket
- `POST /buckets/:bucket/folders` - Create folder
- `DELETE /buckets/:bucket/folders` - Delete folder

## Environment Variables

- `MINIO_ENDPOINT` - MinIO server endpoint
- `MINIO_PORT` - MinIO server port
- `MINIO_ACCESS_KEY` - MinIO access key
- `MINIO_SECRET_KEY` - MinIO secret key
- `MINIO_USE_SSL` - Use SSL for MinIO connection
- `MINIO_BUCKET_NAME` - Default bucket name

## Deployment

The application is designed to run on Kubernetes with automatic deployment via GitHub Actions.

```bash
# Build Docker image
docker build -t photovault-api .

# Deploy to Kubernetes
kubectl apply -f k8s/
```
