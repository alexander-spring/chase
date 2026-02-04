FROM node:20-slim

# Install required system tools
RUN apt-get update && apt-get install -y \
    bash \
    jq \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Set working directory
WORKDIR /app

# Copy and install patched agent-browser (with stealth fixes for bot detection)
COPY agent-browser-patched/ ./agent-browser-patched/
RUN cd agent-browser-patched && npm install --omit=dev && npm link

# Verify agent-browser is accessible
RUN agent-browser --version || echo "agent-browser installed"

# Copy package files first (for better layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy compiled code
COPY dist/ ./dist/

# Create directories for generated scripts and sessions
RUN mkdir -p /app/generated /app/sessions

# Set environment variables
ENV PORT=8080
ENV HOST=0.0.0.0
ENV OUTPUT_DIR=/app/generated
ENV SESSIONS_DIR=/app/sessions
ENV NODE_ENV=production

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start the HTTP server
CMD ["node", "dist/server.js"]
