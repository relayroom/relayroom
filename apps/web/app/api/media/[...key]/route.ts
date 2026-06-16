import { NextRequest, NextResponse } from "next/server"
import { getStorage } from "@/lib/storage"

/**
 * Serve storage files.
 *
 * Security note: files are served without per-request authentication for now.
 * The storage key itself is a content-hash (SHA-256 prefix), so keys are
 * unpredictable — effectively a "capability URL". This is the same model used
 * by many major platforms (S3 pre-signed style but persistent). For sensitive
 * project data we should add session-based access control in a future iteration:
 *   1. Look up the projectId from the key prefix
 *   2. Verify the caller is a member of that project's org
 * For the current use case (project thumbnails / background images visible to
 * org members anyway), serving by key is acceptable. Tighten before handling
 * truly private assets.
 *
 * Cache: immutable 1-year for content-addressed keys. If a file changes, the
 * hash changes and a new URL is returned.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key: segments } = await params
  const key = segments.join("/")

  const storage = getStorage()
  const file = await storage.get(key)

  if (!file) {
    return new NextResponse(null, { status: 404 })
  }

  return new NextResponse(file.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.length),
      // Content-addressed: safe to cache immutably (hash in filename)
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
}
