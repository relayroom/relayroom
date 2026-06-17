FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/telemetry/package.json packages/telemetry/
RUN pnpm install --frozen-lockfile --filter @relayroom/server...
COPY tsconfig.base.json ./
COPY apps/server apps/server
COPY packages/db packages/db
COPY packages/shared packages/shared
COPY packages/telemetry packages/telemetry

# Drop root: run as the unprivileged `node` user baked into the official image, so a
# container escape lands as uid 1000, not root. chown the app dir so any runtime
# scratch writes (pnpm cache / $HOME) succeed under the node user.
RUN chown -R node:node /app
USER node

# Baked release version: the single source the running app reports via telemetry
# (RELAYROOM_VERSION). CI passes the release tag; defaults to the lockstep baseline.
ARG RELAYROOM_VERSION=0.3.1
ENV RELAYROOM_VERSION=${RELAYROOM_VERSION}

EXPOSE 48801
CMD ["pnpm", "--filter", "@relayroom/server", "start"]
