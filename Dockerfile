# Production image — Render builds it from this repo on every push to main.
# Local try-out:  docker build -t placements .  &&  docker run --rm -p 10000:10000 --env-file .env.local placements
# See docs/deployment.md.

ARG NODE_VERSION=22.19.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
# Chromium comes from the OS packages below, not puppeteer's download.
ENV NEXT_TELEMETRY_DISABLED=1 \
    PUPPETEER_SKIP_DOWNLOAD=true

# 1. Dependencies — cached until package.json / package-lock.json change.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 2. Build, then drop dev dependencies and the build cache.
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf .next/cache

# 3. Runtime: Chromium for the PDF reports, fonts for names and ₹, tini as PID 1 (signals,
#    and no zombie Chromium processes), a non-root user.
FROM base AS runner
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HOSTNAME=0.0.0.0 \
    PORT=10000
COPY --from=build --chown=node:node /app/package.json /app/next.config.mjs ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next ./.next
# Writable at runtime: the 24 h caches and the local PDF fallback (ephemeral on Render).
RUN mkdir -p .cache public/reports && chown -R node:node .cache public/reports
USER node
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "exec node_modules/.bin/next start -H 0.0.0.0 -p ${PORT:-10000}"]
