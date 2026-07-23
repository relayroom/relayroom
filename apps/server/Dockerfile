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

# Baked release version: what the running app reports via telemetry. CI passes the
# release tag (release-images.yml), so official images are correct. NO default here on
# purpose - a hardcoded one silently rots (it sat at 0.3.2 through the 0.4.0 release and
# every source build reported that). Empty means "not baked", and the consumer falls
# back to the package.json version instead. Consumers must test it with `||`, not `??`:
# the ENV below expands to an empty STRING, which `??` would pass through.
ARG RELAYROOM_VERSION=
ENV RELAYROOM_VERSION=${RELAYROOM_VERSION}

EXPOSE 48801
CMD ["pnpm", "--filter", "@relayroom/server", "start"]
