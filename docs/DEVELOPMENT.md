# PhotoVault API - Development Setup

## Quick Start for Local Development

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Start local MinIO (required for development):**
   ```bash
docker run -d \
  --name minio \
  -p 9000:9000 \
  -p 9001:9001 \
  -e MINIO_ROOT_USER=lucarv \
  -e MINIO_ROOT_PASSWORD='lucaPWD$MinI0' \
  quay.io/minio/minio server /data --console-address ":9001"


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

## Debug Development Server

### Basic Development Server
```bash
npm run dev
```
This runs the server with nodemon for auto-restart, but no debug output.

### Debug-Enabled Development

#### Full Debug Output (All Namespaces)
```bash
npm run dev:debug
```
Shows all debug output from all HBVU namespaces.

#### Targeted Debug Output

**Server & API Operations:**
```bash
npm run dev:debug:server
```
Shows server startup, requests, responses, and API endpoint activity.

**File Upload & Processing:**
```bash
npm run dev:debug:upload
```
Shows file upload progress, image processing, storage operations, and conversion details.

**Authentication:**
```bash
npm run dev:debug:auth
```
Shows login attempts, token validation, and authentication middleware activity.

**Database Operations:**
```bash
npm run dev:debug:db
```
Shows database connections, queries, and database-related errors.

**Performance Monitoring:**
```bash
npm run dev:debug:performance
```
Shows timing information, memory usage, and performance metrics.

### Custom Debug Patterns

You can also set custom debug patterns using the DEBUG environment variable:

```bash
# Multiple specific namespaces
DEBUG=hbvu:upload:file,hbvu:server:request npm run dev

# All upload and server namespaces
DEBUG=hbvu:upload:*,hbvu:server:* npm run dev

# Everything except performance
DEBUG=hbvu:* DEBUG_PATTERN=!hbvu:performance:* npm run dev

# Only errors across all namespaces
DEBUG=hbvu:*:error npm run dev
```

### Production Debug (No Auto-Restart)

For production-like testing with debug output:
```bash
npm run start:debug
```

## Debug Output Examples

When running with debug enabled, you'll see structured output like:

```
hbvu:server:startup Server starting on port 5000 +0ms
hbvu:database:connection Connected to MySQL database: photovault +23ms
hbvu:server:startup ✓ Server running on http://localhost:5000 +5ms
hbvu:server:request POST /api/upload/2a1b3c4d +2s
hbvu:upload:file Processing file: IMG_1234.HEIC (2.3 MB) +1ms
hbvu:image:heic Converting HEIC to JPEG +45ms
hbvu:storage:upload Uploading to MinIO: photos/2a1b3c4d/IMG_1234.jpg +234ms
hbvu:performance:timing Upload completed in 1.2s +1s
```

## Environment Variables for Debug

You can also control debug output through environment variables in your `.env` file:

```env
# Enable all HBVU debug output
DEBUG=hbvu:*

# Enable specific patterns
DEBUG=hbvu:server:*,hbvu:upload:*

# Exclude performance monitoring
DEBUG_PATTERN=!hbvu:performance:*
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

### Debug Issues
- **No debug output appearing?**
  - Verify the DEBUG environment variable is set correctly
  - Check that you're using the debug service in your code
  - Make sure there's activity happening (make API requests)

- **Too much output?**
  - Use more specific debug patterns
  - Exclude performance monitoring: `DEBUG_PATTERN=!hbvu:performance:*`
  - Focus on specific areas like `npm run dev:debug:server`

### General Issues
- If MinIO fails to start, check if port 9000/9001 are available
- The API will fail to start without MinIO connection
- Check logs with: `docker-compose logs minio`
