---
"@relayroom/db": patch
---

Make `pnpm --filter @relayroom/db migrate` run, and label the two knowledge defaults nobody derived.

The migrate script lived inline in `package.json` and contained `$client`, which the shell running it expanded to nothing - the command reaching the runtime was `db..end()`, a parse error. Server startup was unaffected because it calls the migration runner directly, so the break was invisible until someone tried to migrate by hand, which is generally when something has already gone wrong. It is now a file rather than a string in a field the shell rewrites.

Two values in the promotion transaction now say what they are. The contradiction window is a number nobody derived, and no code path in this slice reaches it. `confidence` is left unwritten when the caller does not supply it, because the design never defined how it is computed - which means recall ranking currently reduces to trigram similarity, and that is a decision rather than an oversight.
