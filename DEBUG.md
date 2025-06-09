# HBVU PHOTOS Backend API - Debug Module Documentation

## Overview
The backend API now uses a comprehensive debug module using the `debug` npm package for structured logging throughout the application. This replaces all `console.log` statements with organized, controllable debug output.

## Debug Service Architecture

### Location
- **Service File**: `/services/debug-service.js`
- **Usage**: Imported and used throughout all backend modules

### Organized Namespaces

The debug service provides organized logging namespaces for different application areas:

#### **Server Operations** (`hbvu:server:*`)
- `hbvu:server:startup` - Server initialization and startup messages
- `hbvu:server:request` - HTTP request logging with headers, params, query
- `hbvu:server:response` - HTTP response logging with status codes and data
- `hbvu:server:error` - Server-level error messages
- `hbvu:server:shutdown` - Graceful shutdown messages

#### **Authentication** (`hbvu:auth:*`)
- `hbvu:auth:login` - User login attempts and results
- `hbvu:auth:token` - JWT token creation and validation
- `hbvu:auth:middleware` - Authentication middleware operations
- `hbvu:auth:validation` - Input validation and security checks
- `hbvu:auth:error` - Authentication errors and failures

#### **Database Operations** (`hbvu:database:*`)
- `hbvu:database:connection` - Connection pool management
- `hbvu:database:query` - SQL query execution
- `hbvu:database:transaction` - Transaction management
- `hbvu:database:migration` - Schema migrations
- `hbvu:database:error` - Database errors

#### **File Upload Processing** (`hbvu:upload:*`)
- `hbvu:upload:file` - File upload initiation and metadata
- `hbvu:upload:processing` - File processing pipeline
- `hbvu:upload:conversion` - Format conversion operations
- `hbvu:upload:minio` - MinIO storage operations
- `hbvu:upload:progress` - Upload progress tracking
- `hbvu:upload:error` - Upload errors and failures

#### **Storage Operations** (`hbvu:storage:*`)
- `hbvu:storage:bucket` - Bucket operations and validation
- `hbvu:storage:object` - Object listing and management
- `hbvu:storage:list` - Directory and folder listing
- `hbvu:storage:upload` - Object upload operations
- `hbvu:storage:download` - Object download operations
- `hbvu:storage:delete` - Object deletion operations
- `hbvu:storage:error` - Storage errors

#### **Image Processing** (`hbvu:image:*`)
- `hbvu:image:metadata` - Image metadata extraction
- `hbvu:image:heic` - HEIC file processing
- `hbvu:image:avif` - AVIF conversion operations
- `hbvu:image:sharp` - Sharp image processing
- `hbvu:image:conversion` - Format conversion details
- `hbvu:image:error` - Image processing errors

#### **API Endpoints** (`hbvu:api:*`)
- `hbvu:api:buckets` - Bucket API endpoints
- `hbvu:api:objects` - Object API endpoints
- `hbvu:api:folders` - Folder API endpoints
- `hbvu:api:health` - Health check endpoints
- `hbvu:api:error` - API errors

#### **Performance Monitoring** (`hbvu:performance:*`)
- `hbvu:performance:timing` - Operation timing
- `hbvu:performance:memory` - Memory usage tracking
- `hbvu:performance:cpu` - CPU usage monitoring
- `hbvu:performance:size` - File size analytics

## Debug Service Features

### Utility Functions
- **`formatMessage()`** - Formats messages consistently
- **`createTimer()`** - Creates performance timers for operations
- **`logMemoryUsage()`** - Logs current memory usage
- **`formatFileSize()`** - Formats file sizes in human-readable format
- **`initializeDebugPatterns()`** - Sets up debug patterns from environment

### Performance Monitoring
```javascript
const timer = debugService.createTimer()
// ... perform operation ...
debugService.performance.timing('Operation completed', timer.end())
```

### Memory Usage Tracking
```javascript
debugService.logMemoryUsage('After file processing')
```

### File Size Formatting
```javascript
debugService.formatFileSize(12345678) // Returns "11.77 MB"
```

## Environment Variable Configuration

### Development Mode
```bash
# Enable all debug output
DEBUG=hbvu:*

# Enable specific categories
DEBUG=hbvu:server:*,hbvu:upload:*,hbvu:image:*
```

### Production Mode (Kubernetes)
```bash
# Enable only critical logging
DEBUG=hbvu:server:startup,hbvu:server:error,hbvu:auth:error,hbvu:database:error,hbvu:upload:error,hbvu:storage:error,hbvu:image:error,hbvu:api:error

# Custom debug patterns
DEBUG_PATTERN=error,startup,shutdown
```

### Kubernetes Deployment
Add to your deployment configuration:
```yaml
env:
  - name: DEBUG
    value: "hbvu:server:startup,hbvu:server:error,hbvu:auth:error,hbvu:database:error,hbvu:upload:error,hbvu:storage:error,hbvu:image:error,hbvu:api:error"
  - name: DEBUG_PATTERN
    value: "error,startup,shutdown"
```

## Local Development Usage

### Available npm Scripts

```bash
# Basic development (no debug output)
npm run dev

# Full debug output (all namespaces)
npm run dev:debug

# Targeted debug output
npm run dev:debug:server      # Server & API operations
npm run dev:debug:upload      # File upload & processing
npm run dev:debug:auth        # Authentication
npm run dev:debug:db          # Database operations
npm run dev:debug:performance # Performance monitoring

# Production debug (no auto-restart)
npm run start:debug
```

### Custom Debug Patterns

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

## Kubernetes Deployment

### Production Deployment (Standard)

For production deployments, debug output is disabled by default. To enable debug output in production:

1. **Edit the configmap:**
   ```bash
   kubectl edit configmap photovault-api-config -n webapps
   ```

2. **Add debug environment variables:**
   ```yaml
   data:
     PORT: "3001"
     NODE_ENV: "production"
     API_PREFIX: "/api/v1"
     DEBUG: "hbvu:server:*,hbvu:api:*,hbvu:auth:*"
     DEBUG_PATTERN: "!hbvu:performance:*"
   ```

3. **Restart the deployment:**
   ```bash
   kubectl rollout restart deployment photovault-api -n webapps
   ```

### Debug Deployment (Development in Kubernetes)

For development/debugging purposes in Kubernetes, use the dedicated debug deployment:

1. **Deploy debug configmap:**
   ```bash
   kubectl apply -f k8s/configmap-debug.yaml
   ```

2. **Deploy debug version:**
   ```bash
   kubectl apply -f k8s/deployment-debug.yaml
   ```

3. **View debug logs:**
   ```bash
   kubectl logs -f deployment/photovault-api-debug -n webapps
   ```

4. **Clean up debug deployment:**
   ```bash
   kubectl delete -f k8s/deployment-debug.yaml
   kubectl delete -f k8s/configmap-debug.yaml
   ```

### Available Debug Configurations

The `k8s/configmap-debug.yaml` file includes several pre-configured debug patterns:

- **Full debug**: All namespaces except performance
- **Server only**: Server and API operations
- **Upload only**: File upload and processing
- **Auth only**: Authentication operations

## Debug Output Examples

### Server Startup
```
hbvu:server:startup Running in demo authentication mode +0ms
hbvu:server:startup PhotoVault API server running on port 3001 +2ms
hbvu:server:startup Health check: http://localhost:3001/health +0ms
hbvu:server:startup MinIO endpoint: objects.hbvu.su:443 +0ms
```

### File Upload Process
```
hbvu:server:request POST /api/upload/2a1b3c4d +2s
hbvu:upload:file Processing file: IMG_1234.HEIC (2.3 MB) +1ms
hbvu:image:heic Converting HEIC to JPEG +45ms
hbvu:storage:upload Uploading to MinIO: photos/2a1b3c4d/IMG_1234.jpg +234ms
hbvu:performance:timing Upload completed in 1.2s +1s
```

### Authentication Flow
```
hbvu:auth:login User login attempt: admin +0ms
hbvu:auth:token Generating JWT token for user: admin +5ms
hbvu:auth:middleware Token validation successful +2ms
```

## Environment Variables

### Local Development (.env file)
```env
# Enable all HBVU debug output
DEBUG=hbvu:*

# Enable specific patterns
DEBUG=hbvu:server:*,hbvu:upload:*

# Exclude performance monitoring
DEBUG_PATTERN=!hbvu:performance:*
```

### Kubernetes Environment
Set in ConfigMap or directly in deployment:
```yaml
env:
  - name: DEBUG
    value: "hbvu:*"
  - name: DEBUG_PATTERN
    value: "!hbvu:performance:*"
```

## Troubleshooting

### No Debug Output
- Verify DEBUG environment variable is set
- Check that debug service is imported in code
- Ensure there's application activity to log

### Too Much Output
- Use specific debug patterns instead of `hbvu:*`
- Exclude performance monitoring: `DEBUG_PATTERN=!hbvu:performance:*`
- Focus on specific areas (e.g., `hbvu:server:*`)

### Performance Impact
- Debug output adds minimal overhead when disabled
- Performance namespace (`hbvu:performance:*`) has higher overhead
- In production, only enable specific namespaces as needed

## Implementation Status

✅ **Complete Implementation:**
- Debug service created with all namespaces
- All console.log statements replaced across codebase
- npm scripts added for easy development
- Kubernetes configurations created
- Documentation completed

**Files Updated:**
- `services/debug-service.js` - New comprehensive debug service
- `server.js` - All logging converted to debug
- `services/upload-service.js` - All logging converted to debug
- `config/database.js` - All logging converted to debug
- `middleware/auth.js` - All logging converted to debug
- `routes/auth.js` - All logging converted to debug
- `heic-processor.js` - All logging converted to debug
- `package.json` - Debug scripts added
- `k8s/configmap.yaml` - Debug configuration options added
- `k8s/configmap-debug.yaml` - Debug-specific configmap created
- `k8s/deployment-debug.yaml` - Debug deployment created
