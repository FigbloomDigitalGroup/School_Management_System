# syntax=docker/dockerfile:1
# The FigBloom API image: the HTTP API, the background worker and the release/operator commands, from one build.
# Build context: the repository root. /.dockerignore is an allowlist, so .env files and node_modules never enter it.
#
#   docker build -f infra/api/Dockerfile -t figbloom-api .
#
# The container's first argument picks the process (infra/api/entrypoint.mjs): api | worker | release | ...

ARG NODE_IMAGE=node:24.18.0-bookworm-slim

# npm needs every workspace's package.json to read the lockfile, even though only @figbloom/api is installed.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/

FROM manifests AS build
RUN npm ci --workspace @figbloom/api --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
RUN npm run build --workspace @figbloom/api

FROM manifests AS prod-deps
RUN npm ci --omit=dev --workspace @figbloom/api --include-workspace-root=false --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Amazon RDS certificate authorities, for sslmode=verify-full.
# (ADD --chmod would also apply to the folder it creates and lock the non-root user out of it.)
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
RUN chmod 755 /app/certs && chmod 444 /app/certs/rds-global-bundle.pem
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/package.json apps/api/
COPY apps/api/migrations apps/api/migrations
COPY apps/api/scripts apps/api/scripts
COPY infra/api/entrypoint.mjs infra/api/
COPY infra/api/ops infra/api/ops
USER node
ENTRYPOINT ["node", "/app/infra/api/entrypoint.mjs"]
CMD ["api"]
