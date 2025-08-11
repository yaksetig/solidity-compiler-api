FROM node:20-slim

WORKDIR /app

# Copy manifest(s) first for layer caching
COPY package.json package-lock.json* ./

# Install deps (tolerant if no lockfile present)
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# Copy source
COPY src ./src

# Security hardening
RUN addgroup --system nodegrp && adduser --system --ingroup nodegrp nodeuser && \
    mkdir -p /app && chown -R nodeuser:nodegrp /app && \
    mkdir -p /tmp/solc-cache && chown -R nodeuser:nodegrp /tmp/solc-cache
USER nodeuser

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["npm", "start"]
