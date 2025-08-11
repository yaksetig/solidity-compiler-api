# Use a slim Node image to keep Railway costs/boot times low
FROM node:20-slim

# Create app dir
WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

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
