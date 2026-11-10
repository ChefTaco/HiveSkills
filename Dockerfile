ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.0-1@sha256:48948514bce59a27f8ee2a3eabaea0a04cbfa87e087297a52f8501c0d465c84f
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /build
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --ignore-scripts && npm --prefix tooling/release ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM ${RUNTIME_IMAGE}
USER root
ENV NODE_ENV=production HIVE_SKILLS_HOST=0.0.0.0 HIVE_AUTO_MIGRATE=false HIVE_AUTO_UPGRADE=false HIVE_UPDATE_CHECK=false HIVE_HOME=/data
RUN mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /build/package.json /app/package.json
COPY --from=build --chown=node:node /build/node_modules /app/node_modules
COPY --from=build --chown=node:node /build/dist /app/dist
COPY --from=build --chown=node:node /build/scripts/archive-utils.mjs /app/scripts/archive-utils.mjs
COPY --from=build --chown=node:node /build/scripts/hermes-sync.mjs /app/scripts/hermes-sync.mjs
COPY --from=build --chown=node:node /build/registry-sources /app/registry-sources
COPY LICENSE NOTICE /app/
COPY scripts/container-health.mjs /app/healthcheck.mjs
ENV HIVE_HEALTH_URL=https://localhost:4030/healthz
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD ["node", "/app/healthcheck.mjs"]
USER node
WORKDIR /app/.
VOLUME ["/data"]
EXPOSE 4030
ENTRYPOINT ["node", "dist/cli.js"]
