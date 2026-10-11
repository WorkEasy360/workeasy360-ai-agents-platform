# syntax=docker/dockerfile:1.7
# API and worker image (same image; docker-compose picks the command for the worker and the one-off tasks).
#   docker build -f apps/api/Dockerfile -t we360-agents-api .
#   API:    docker run we360-agents-api
#   Worker: docker run we360-agents-api node dist/worker.js
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build
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

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
WORKDIR /app
ENV NODE_ENV=production
# Trust the RDS CA so database connections can verify the server certificate (sslmode=verify-full).
# Pinned checksum: the build fails if the downloaded bundle changes. When AWS publishes a new bundle,
# re-run: curl -sL <url> | sha256sum, verify it on the AWS docs page, then update the hash below.
ADD --chmod=644 --checksum=sha256:fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c \
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
