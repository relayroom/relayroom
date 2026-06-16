/**
 * Storage abstraction for RelayRoom media files.
 *
 * Files are written to a volume-mounted `storage/` directory (NOT the container
 * filesystem), so they survive container restarts and can be replaced with an
 * S3/R2 driver later — callers never deal with paths or bucket names directly.
 *
 * Interface contract
 * ──────────────────
 *   put(key, bytes, contentType) - write bytes under `key`
 *   get(key)                     - read bytes + contentType, or null if missing
 *   url(key)                     - public URL to serve the file (served by /api/media)
 *
 * The DB stores the relative `key` only — never an absolute path or full URL —
 * so switching drivers requires no DB migration.
 */

export interface StorageDriver {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<{ bytes: Buffer; contentType: string } | null>
  /** Returns the public URL for a given storage key. */
  url(key: string): string
}

// ── Factory ───────────────────────────────────────────────────────────────────

let _driver: StorageDriver | null = null

/**
 * Returns the active storage driver.
 *
 * Driver selection is controlled by the STORAGE_DRIVER env var:
 *   "local" (default) → LocalStorageDriver (volume-mounted filesystem)
 *
 * Future drop-in: set STORAGE_DRIVER=s3 and supply S3_BUCKET / S3_REGION /
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY to swap to an S3/R2 driver without
 * touching any upload or serve code.
 */
export function getStorage(): StorageDriver {
  if (_driver) return _driver

  const driverName = process.env.STORAGE_DRIVER ?? "local"

  if (driverName === "local") {
    // Lazy-require to avoid importing `fs` in edge runtimes (upload route is Node).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalStorageDriver } = require("./local") as typeof import("./local")
    _driver = new LocalStorageDriver()
    return _driver
  }

  throw new Error(`[storage] Unknown STORAGE_DRIVER="${driverName}". Supported: "local"`)
}
