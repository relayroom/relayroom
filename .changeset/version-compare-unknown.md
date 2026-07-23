---
"@relayroom/web": patch
---

Stop advertising an update when the running version cannot be parsed. The semver comparison coerced an unreadable version to `0.0.0`, which is older than every release, so any instance whose version could not be read was told to upgrade to a release it might already be on. An unparseable version is now treated as unknown and suppresses the prompt rather than triggering it.
