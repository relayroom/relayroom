// Reject control chars (U+0000-U+001F incl. tab/newline), space (U+0020), and backslash -
// these enable host-confusion after the URL is normalized by a browser.
const UNSAFE_CHARS = new RegExp("[\\u0000-\\u0020\\\\]")

/**
 * Validate a post-login redirect target to prevent open-redirect / `javascript:` XSS.
 *
 * Only same-origin absolute paths are allowed. Defenses, in order:
 *  1. Percent-decode the input so encoded attacks (e.g. `/%09/evil.com` -> `/\t/evil.com`)
 *     surface as literal chars. Malformed encoding is rejected.
 *  2. Reject control chars / whitespace / backslashes in BOTH the raw and decoded forms -
 *     `/\t/evil.com` normalizes to `//evil.com` (origin `evil.com`) in the URL parser.
 *  3. Require a single leading slash (not `//`) in both forms.
 *  4. Parse with the URL API against a fixed dummy origin; the resolved origin MUST stay
 *     that origin, else it's cross-origin.
 *
 * Anything that fails falls back to "/".
 */
export function safeRedirect(to: string | undefined): string {
  if (!to) return "/"

  let decoded: string
  try {
    decoded = decodeURIComponent(to)
  } catch {
    return "/"
  }

  if (UNSAFE_CHARS.test(to) || UNSAFE_CHARS.test(decoded)) return "/"
  if (!to.startsWith("/") || to.startsWith("//")) return "/"
  if (decoded.startsWith("//")) return "/"

  try {
    const u = new URL(to, "http://localhost")
    if (u.origin !== "http://localhost") return "/"
    return u.pathname + u.search + u.hash
  } catch {
    return "/"
  }
}
