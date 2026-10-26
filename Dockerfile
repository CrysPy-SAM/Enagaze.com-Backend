# Engaze.com — Production-Grade Multi-Stage Dockerfile
#
# Builds a secure, minimal container image suitable for both:
# 1. Express API server (default CMD)
# 2. BullMQ background worker (override CMD with: npm run worker)

# -----------------------------------------------------------------------------
# Stage 1: Build Dependencies
# -----------------------------------------------------------------------------
FROM node:22-alpine AS dependencies

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install production runtime dependencies reproducibly
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 2: Runtime Container
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

# Default to production environment
ENV NODE_ENV=production

# Run as non-root user (built-in 'node' user: UID 1000, GID 1000)
USER node

# Copy installed production dependencies from builder stage
COPY --chown=node:node --from=dependencies /app/node_modules ./node_modules

# Copy application manifests and source code
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/

# Expose default API server port
EXPOSE 8000

# Default command starts the Express API server.
# BullMQ worker containers override this command with: ["npm", "run", "worker"]
CMD ["node", "src/app.js"]

