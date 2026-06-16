# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

Every change that affects a published surface (the `@relayroom/cli` npm package,
the `relayroom-server` / `relayroom-web` Docker images, or the docs snapshot)
needs a changeset. Add one with:

```bash
pnpm changeset
```

All RelayRoom packages are in a single **fixed** group, so they always release
under the same version number. That one version propagates to npm, the Docker
image tags, the docs snapshot, and the app-baked `RELAYROOM_VERSION` that
telemetry reports - one number, every surface, no manual sync.

The first public release is **0.3.0** (0.1.x/0.2.x were burned on npm and can
never be reused). Private packages are versioned for lockstep but never
published to npm.
