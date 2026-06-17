# ---- deps + build stage ----
FROM node:24-alpine AS builder
RUN corepack enable

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/telemetry/package.json packages/telemetry/

# Install deps filtered to web (and its workspace deps: @relayroom/db, shared, telemetry)
RUN pnpm install --frozen-lockfile --filter @relayroom/web...

# Copy source
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/db packages/db
COPY packages/shared packages/shared
COPY packages/telemetry packages/telemetry

RUN pnpm --filter @relayroom/web build

# ---- runtime stage ----
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=48800
ENV HOSTNAME=0.0.0.0

# Baked release version (single source, matches the server image tag). Set by CI.
ARG RELAYROOM_VERSION=0.3.2
ENV RELAYROOM_VERSION=${RELAYROOM_VERSION}

# Copy standalone output (monorepo: lands at .next/standalone/apps/web/), owned by
# the unprivileged `node` user so the runtime never needs root.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
# Copy static assets into the right location inside standalone tree
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# Copy public folder
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

# Drop root: a container escape lands as uid 1000, not root.
USER node

EXPOSE 48800

CMD ["node", "apps/web/server.js"]
