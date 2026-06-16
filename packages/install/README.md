# @relayroom/install

Interactive installer for self-hosting [RelayRoom](https://relayroom.dev).

```bash
npx @relayroom/install
```

It asks a few questions (install directory, public URLs, ports, optional SMTP),
generates strong secrets, and writes a self-contained `docker-compose.yml` + `.env`
that run the prebuilt public images from GHCR. No source checkout, no build step.
Optionally it can start the stack for you.

The pinned image version defaults to the installer's own version, so
`npx @relayroom/install@0.3.0` installs RelayRoom 0.3.0 - server and web move in
lockstep.

After it finishes:

```bash
cd relayroom
sudo chown -R 1000:1000 storage   # the container runs as uid 1000
docker compose up -d
```

Then open the dashboard URL and create the first admin account. The server runs
database migrations on boot, so there is nothing else to set up.

Run non-interactively (accept all defaults) with `-y`.

Docs: https://relayroom.dev/docs
