# syntax=docker/dockerfile:1
# Build context: backend/ (docker build -f backend/Dockerfile backend)
# Node runs the TypeScript sources directly (native type stripping): there is no
# compile step. Type checking and tests run in the CI pipeline, not here.

# ---- deps: production dependencies only ------------------------------------
# node:24.22.2-bookworm (multi-arch index digest), same as the backoffice.
FROM node:24.22.2-bookworm@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# No lifecycle scripts: sharp ships its prebuilt libvips binary as a platform
# package (@img/sharp-*), installed as an ordinary optional dependency.
RUN npm ci --omit=dev --ignore-scripts

# ---- runtime: non root, sources and production dependencies only ------------
# node:24.22.2-bookworm-slim (multi-arch index digest): glibc, as required by the
# prebuilt sharp binary installed above.
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
# The runtime needs only `node`: drop the package managers to shrink the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# Numeric user so Kubernetes `runAsNonRoot` can verify it; files are read-only to it.
USER 1000:1000
EXPOSE 3000
# Configuration and secrets come from the environment (ConfigMap and Secret on
# GKE), never from a .env file: .dockerignore keeps it out of the image, and with
# APP_ENV=production the server refuses to start if one is present.
# No HEALTHCHECK: GKE probes /health/live and /health/ready.
CMD ["node", "src/server.ts"]
