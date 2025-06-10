# PhotoVault Authentication System

This document describes the dual-mode authentication system implemented in PhotoVault, supporting both development (demo) and production (database) authentication modes.

## Overview

PhotoVault now supports two authentication modes:

1. **Demo Mode** (`demo`) - For development and testing with hardcoded credentials
2. **Database Mode** (`database` or `api`) - For production with MariaDB user authentication

## Authentication Modes

### Demo Mode
- **Purpose**: Development and testing
- **Credentials**: Hardcoded in the application
- **Users**: 
  - Admin: `admin` / `admin123`
  - User: `user` / `user123`
- **Storage**: No database required, uses JWT tokens with local validation

### Database Mode  
- **Purpose**: Production deployment
- **Credentials**: Stored in MariaDB with bcrypt-hashed passwords
- **Users**: Created and managed through the database
- **Storage**: MariaDB database with proper user management

## Configuration

### Frontend Configuration

Set the authentication mode in your environment:

```bash
# .env file
VITE_API_URL=https://vault-api.hbvu.su
VITE_AUTH_MODE=demo  # or 'api' for production
```

### Backend Configuration

Configure the API server authentication:

```bash
# .env file
PORT=3001
AUTH_MODE=demo  # or 'database' for production

# JWT Configuration (for production)
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=24h

# Database Configuration (when AUTH_MODE=database)
DB_HOST=mariadb.data.svc.cluster.local
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your-mariadb-password
DB_NAME=photovault

# MinIO Configuration
MINIO_ENDPOINT=minio-service.minio.svc.cluster.local
MINIO_PORT=9000
MINIO_ACCESS_KEY=your-access-key
MINIO_SECRET_KEY=your-secret-key
```

## API Endpoints

### Authentication Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/auth/login` | User login | No |
| GET | `/auth/me` | Get current user info | Yes |
| POST | `/auth/logout` | User logout | Yes |
| GET | `/auth/status` | Check auth status and mode | No |
| POST | `/auth/refresh` | Refresh JWT token | Yes |

### Protected Endpoints

All bucket-related operations now require authentication:

| Method | Endpoint | Description | Role Required |
|--------|----------|-------------|---------------|
| GET | `/buckets` | List buckets | User |
| POST | `/buckets` | Create bucket | Admin |
| GET | `/buckets/:name/objects` | List objects | User |
| POST | `/buckets/:name/upload` | Upload files | User |
| POST | `/buckets/:name/folders` | Create folder | Admin |
| DELETE | `/buckets/:name/folders` | Delete folder | Admin |
| GET | `/buckets/:name/download` | Download object | User |

## Database Schema

When using database mode, the following table structure is required:

```sql
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin', 'user') DEFAULT 'user',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL,
    
    INDEX idx_username (username),
    INDEX idx_email (email),
    INDEX idx_role (role),
    INDEX idx_active (is_active)
);
```

## Development Setup

### 1. Demo Mode (Default)

For local development, simply use demo mode:

```bash
# Frontend (.env)
VITE_API_URL=http://localhost:3001
VITE_AUTH_MODE=demo

# Backend (.env)
PORT=3001
AUTH_MODE=demo
```

Start both servers:

```bash
# Terminal 1 - API Server
cd photovault-api
npm install
npm start

# Terminal 2 - Frontend
cd photovault-fe
npm install
npm run dev
```

Login with:
- Admin: `admin` / `admin123`
- User: `user` / `user123`

### 2. Database Mode

For production-like testing:

1. **Setup MariaDB**:
   ```bash
   # Create database and user table
   mysql -u root -p
   CREATE DATABASE photovault;
   USE photovault;
   # Run the schema from database/init.sql
   ```

2. **Configure Backend**:
   ```bash
   # Backend (.env)
   AUTH_MODE=database
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=your-password
   DB_NAME=photovault
   JWT_SECRET=your-secret-key
   ```

3. **Configure Frontend**:
   ```bash
   # Frontend (.env)
   VITE_AUTH_MODE=api
   ```

## Production Deployment

### Kubernetes Deployment

1. **Update API Secret**:
   ```yaml
   # k8s/secret.yaml
   stringData:
     AUTH_MODE: "database"
     JWT_SECRET: "your-production-jwt-secret"
     DB_PASSWORD: "your-mariadb-password"
   ```

2. **Update Frontend Deployment**:
   ```yaml
   # k8s/deployment.yaml
   env:
     - name: VITE_AUTH_MODE
       value: "api"
   ```

3. **Apply Changes**:
   ```bash
   kubectl apply -f k8s/secret.yaml
   kubectl apply -f k8s/deployment.yaml
   ```

## Security Features

### JWT Token Management
- Secure token generation with configurable expiration
- Automatic token validation on protected routes
- Client-side token storage in localStorage
- Automatic logout on token expiration

### Password Security
- bcrypt hashing for stored passwords (database mode)
- Configurable JWT secret key
- Role-based access control (admin/user)

### API Protection
- All bucket operations require authentication
- Admin-only operations (bucket creation, folder management)
- Automatic 401 handling in frontend

## Testing Authentication

### Demo Mode Testing
```bash
# Login
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin123"}'

# Use returned token for protected requests
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3001/buckets
```

### Database Mode Testing
```bash
# Check auth status
curl http://localhost:3001/auth/status

# Test with database credentials
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "your-db-user", "password": "your-db-password"}'
```

## Migration from Demo to Production

1. **Set up MariaDB database**
2. **Create users table** using `database/init.sql`
3. **Update environment variables** to use database mode
4. **Update Kubernetes secrets** with database credentials
5. **Deploy updated configuration**
6. **Test authentication endpoints**

## Troubleshooting

### Common Issues

1. **"Module not found" errors**:
   ```bash
   npm install  # Make sure all dependencies are installed
   ```

2. **Database connection failures**:
   - Check MariaDB is running and accessible
   - Verify database credentials in environment variables
   - Check network connectivity to database host

3. **JWT token errors**:
   - Ensure JWT_SECRET is set in production
   - Check token expiration settings
   - Verify token format in Authorization header

4. **Authentication failures**:
   - Check auth mode configuration (demo vs database)
   - Verify credentials are correct
   - Check API server logs for detailed errors

### Logs and Debugging

The API server provides detailed logging:
```bash
# Check server startup logs
🎭 Running in demo authentication mode
👤 Demo users: admin/admin123, user/user123

# Check authentication attempts
Login error: Invalid username or password
✅ Database initialized successfully
```

Monitor the frontend console for authentication state changes and API call results.
