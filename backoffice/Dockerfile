# syntax=docker/dockerfile:1
# Build context: backoffice/ (docker build -f backoffice/Dockerfile backoffice)

# ---- build: compile the Angular app --------------------------------------
# node:24.22.2-bookworm (multi-arch index digest)
FROM node:24.22.2-bookworm@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build \
 && rm -rf server/test

# ---- runtime: dependency-free Node static server, non root ---------------
# node:24.22.2-bookworm-slim (multi-arch index digest), same Node version as the build.
# Chosen over distroless: same runtime, easy to patch with the base-image
# digest bump, and `node` (uid 1000) already exists. No package manager use,
# no dependencies installed: only dist/ and server/ are copied.
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/server ./server
# The runtime needs only `node`: drop the package managers to shrink the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# Numeric user so Kubernetes `runAsNonRoot` can verify it; files are read-only to it.
USER 1000:1000
EXPOSE 8080
# API_BASE_URL is required at start (public configuration, injected by the
# deployment, never baked into the image). No HEALTHCHECK: GKE probes /healthz.
CMD ["node", "server/main.ts"]
