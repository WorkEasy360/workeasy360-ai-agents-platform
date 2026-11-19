# syntax=docker/dockerfile:1.7
# API and worker image (same image; docker-compose picks the command for the worker and the one-off tasks).
#   docker build -f apps/api/Dockerfile -t we360-agents-api .
#   API:    docker run we360-agents-api
#   Worker: docker run we360-agents-api node dist/worker.js
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @we360/api... --filter @we360/db...
COPY apps/api apps/api
COPY packages/db packages/db
RUN pnpm --filter @we360/api build \
 && pnpm --filter @we360/api deploy --prod --legacy /out

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
ENV NODE_ENV=production
# Trust the RDS CA so database connections can verify the server certificate (sslmode=verify-full).
# Pinned checksum: the build fails if the downloaded bundle changes. AWS publishes no checksum, so when it
# publishes a new bundle (it adds roots for each new region), compare its certificates with the previous
# bundle's (extract /etc/ssl/rds-global-bundle.pem from the last deployed image): every added certificate must
# be a self-signed "Amazon RDS <region> Root CA" from Amazon Web Services, Inc. that also appears in that
# region's bundle, https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem. Then update the hash.
# 2026-11-18: AWS's 2026-10-14 bundle adds the three sa-west-1 (Chile) roots and removes nothing.
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/packages/db/migrations ./migrations
USER node
EXPOSE 4000
# Readiness of the API: /api/health answers 503 unless the database and Redis both respond.
# (The worker uses the same image; deploy/docker-compose.prod.yml gives it its own check.)
HEALTHCHECK --interval=30s --timeout=8s --start-period=40s --retries=3   CMD ["node", "-e", "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
