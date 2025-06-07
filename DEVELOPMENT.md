# PhotoVault API - Development Setup

## Quick Start for Local Development

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Start local MinIO (required for development):**
   ```bash
   npm run dev:setup
   ```
   This will:
   - Start MinIO container on localhost:9000
   - Create the 'photos' bucket automatically
   - Start the API in development mode with nodemon

3. **Access MinIO Console:**
   - Console: http://localhost:9001
   - Username: `minioadmin`
   - Password: `minioadmin`

4. **Stop development environment:**
   ```bash
   npm run dev:stop
   ```

## Environment Configuration

- **Local Development**: Uses `.env` file with local MinIO
- **Kubernetes Production**: Uses ConfigMap + Secret

## Development vs Production

| Environment | MinIO Location | SSL | Port |
|-------------|---------------|-----|------|
| Local Dev   | localhost     | No  | 9000 |
| Kubernetes  | objects.hbvu.su | Yes | 443  |

## Troubleshooting

- If MinIO fails to start, check if port 9000/9001 are available
- The API will fail to start without MinIO connection
- Check logs with: `docker-compose logs minio`
