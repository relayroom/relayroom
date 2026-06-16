import { fileURLToPath } from "node:url"

/**
 * Absolute path to a bundled runtime script (the pager / usage hook). These ship
 * as-is under the package's `runtime/` dir (see package.json `files`), alongside
 * the compiled `dist/`. Resolving from import.meta.url works both from the repo
 * (packages/cli/dist → ../runtime) and from an installed package.
 */
export function runtimePath(
  name: "relayroom-pager.mjs" | "usage-report.mjs" | "relayroom-channel.mjs",
): string {
  return fileURLToPath(new URL(`../runtime/${name}`, import.meta.url))
}
