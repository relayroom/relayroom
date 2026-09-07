/**
 * The CLI's own version, injected at build time by tsup from package.json.
 *
 * In its own module because two places need it and they must agree: `--version`, and the
 * stamp `init` writes into a generated rr.sh. A script that reports a different version
 * than the CLI that wrote it would make the staleness check answer about nothing.
 */
declare const __CLI_VERSION__: string
export const CLI_VERSION = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev"
