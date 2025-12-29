# Base image with Node.js and Alpine for minimal footprint
FROM node:22-alpine AS production

# Install only runtime dependencies needed for sharp and heic processing
RUN apk add --no-cache \
    vips \
    libc6-compat

# Set working directory
WORKDIR /app

# Copy package files and install only production dependencies
COPY --chown=1001:1001 package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source code with correct ownership
COPY --chown=1001:1001 src/ ./src/

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S photovault -u 1001 -G nodejs

USER photovault

# Expose port
EXPOSE 3000

# Health check is handled by Kubernetes, so no need here

# Start the application
CMD ["npm", "start"]
