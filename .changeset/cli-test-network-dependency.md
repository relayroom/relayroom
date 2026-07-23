---
"@relayroom/cli": patch
---

Stop a CLI test from downloading the published package to test the local one.

`rr.sh` falls back to `npx -y @relayroom/cli` when `relayroom` is not on `PATH`, which is correct product behaviour. In the test environment it meant the `doctor` case fetched the package from the npm registry - so the test exercised whatever was published rather than the code under test, and failed in CI where nothing installs the CLI globally while passing on any machine that has it. A stub on `PATH` removes the network from a unit test.

The test and subprocess timeouts now come from one place, with the test budget strictly larger than the child's. Equal values would race, and a vitest timeout that wins reports its own generic message instead of whatever the child actually did. A guard test asserts the relationship holds and that no test file quietly declares a child budget the config cannot outlast.
