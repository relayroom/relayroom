---
"@relayroom/cli": patch
---

0.6.1 could not start. Upgrade straight to this version.

0.6.1 introduced `channel on|off` for the delivery intent, next to the existing `channel` command that runs the channel server. Commander rejects a duplicate command name when it is registered, which happens at import - before any argument is read - so every invocation of the CLI threw, including the one the launcher makes. `./rr.sh up` ended in `failed to set delivery=channel - aborting launch` and no agent started.

The server command is the one that moved, to `channel-server`. Every `.mcp.json` inspected spawns `relayroom-channel.mjs` directly, so that wrapper had no callers, while `channel on|off` is already named by `rr.sh --channel`, by the config, and by the 0.6.1 notes.

The reason 185 passing tests did not notice is the part worth reading. The CLI tests run the built `dist/index.js`, and CI ran the test job **before** the build job - so they asserted against whatever build happened to be sitting there rather than against the code in the commit. `tsc` does not see a duplicate registration, since nothing about it is a type error, and the bundler built it without complaint. No individual step was wrong. The order meant the thing under test was never the thing being shipped.

CI now builds before testing, the same ordering applies locally, and a new test starts the built CLI and asserts that it registers its commands and lists each one exactly once - which is the assertion 0.6.1 was missing rather than one it failed.
