# Multi-stage build for smaller final image
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install ALL dependencies (including dev)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Production stage
FROM node:18-alpine AS production

# Install only runtime dependencies needed for sharp and heic processing
RUN apk add --no-cache \
    vips-dev \
    libc6-compat

# Set working directory
WORKDIR /app

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY src/ ./src/

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S photovault -u 1001

# Change ownership of app directory more efficiently
RUN chown -R photovault:nodejs /app

USER photovault

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["npm", "start"]
