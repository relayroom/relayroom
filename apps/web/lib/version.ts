import "server-only"

// Baked at image build (Dockerfile ARG RELAYROOM_VERSION). Falls back for local dev.
export const CURRENT_VERSION = process.env.RELAYROOM_VERSION ?? "0.3.11"

export interface VersionInfo {
  current: string
  latest: string | null
  updateAvailable: boolean
}

function parts(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0)
}

/** True if `latest` is a higher semver than `current` (major.minor.patch). */
function isNewer(latest: string, current: string): boolean {
  const a = parts(latest)
  const b = parts(current)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * Current instance version plus, best-effort, whether a newer release exists.
 * The latest is read from the public GitHub releases (cached a day, timeout-bounded).
 * Fails soft: any error just means "no update info", never blocks the dashboard.
 */
export async function getVersionInfo(): Promise<VersionInfo> {
  const current = CURRENT_VERSION
  try {
    const res = await fetch(
      "https://api.github.com/repos/relayroom/relayroom/releases/latest",
      {
        headers: { accept: "application/vnd.github+json" },
        next: { revalidate: 86400 },
        signal: AbortSignal.timeout(4000),
      },
    )
    if (!res.ok) return { current, latest: null, updateAvailable: false }
    const json = (await res.json()) as { tag_name?: string }
    const latest = json.tag_name ? json.tag_name.replace(/^v/, "") : null
    return { current, latest, updateAvailable: !!latest && isNewer(latest, current) }
  } catch {
    return { current, latest: null, updateAvailable: false }
  }
}
