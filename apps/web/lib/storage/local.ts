import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import type { StorageDriver } from "./index"

/**
 * Local filesystem storage driver.
 *
 * Root directory resolution (in priority order):
 *   1. STORAGE_DIR env var  — used in production (Docker: volume-mounted /app/storage)
 *   2. <repo-root>/.storage — dev convenience when running `pnpm dev` locally
 *   3. os.tmpdir()/relayroom-storage — last-resort fallback (e.g. CI)
 *
 * Files are written at  <root>/<key>  preserving subdirectory structure.
 * Keys look like:  project/<projectId>/thumbnail-<hash>.webp
 *                  upload/<userId>/<hash>.webp
 *
 * All public URLs are routed through /api/media/<key> so the driver stays
 * behind the application layer; no direct filesystem access from the browser.
 */
export class LocalStorageDriver implements StorageDriver {
  private readonly root: string

  constructor() {
    if (process.env.STORAGE_DIR) {
      this.root = process.env.STORAGE_DIR
    } else if (process.env.NODE_ENV !== "production") {
      // Dev: put .storage next to the repo root (two levels up from apps/web)
      // __dirname is apps/web/lib/storage at runtime; go up 4 levels → repo root
      const repoRoot = path.resolve(__dirname, "../../../../")
      this.root = path.join(repoRoot, ".storage")
    } else {
      // Last resort fallback
      this.root = path.join(os.tmpdir(), "relayroom-storage")
    }
  }

  private resolve(key: string): string {
    // Prevent path traversal: strip leading slashes and reject ".."
    const safe = key.replace(/\\/g, "/").replace(/^\/+/, "")
    if (safe.includes("..")) throw new Error(`[storage] Invalid key: ${key}`)
    return path.join(this.root, safe)
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const filePath = this.resolve(key)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // Write the file + a tiny sidecar for content-type (avoids magic-byte sniffing)
    await fs.writeFile(filePath, bytes)
    await fs.writeFile(`${filePath}.type`, contentType, "utf8")
  }

  async get(key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const filePath = this.resolve(key)
    try {
      const [bytes, contentType] = await Promise.all([
        fs.readFile(filePath),
        fs.readFile(`${filePath}.type`, "utf8").catch(() => "application/octet-stream"),
      ])
      return { bytes, contentType: contentType.trim() }
    } catch {
      return null
    }
  }

  url(key: string): string {
    const safe = key.replace(/\\/g, "/").replace(/^\/+/, "")
    return `/api/media/${safe}`
  }
}
