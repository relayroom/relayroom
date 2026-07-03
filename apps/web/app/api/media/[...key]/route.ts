import { NextRequest, NextResponse } from "next/server"
import { and, eq } from "drizzle-orm"
import { getStorage } from "@/lib/storage"
import { getServerSession } from "@/lib/auth-session"
import { db } from "@/modules/drizzle/db"
import { projects } from "@relayroom/db/schema"
import { better_auth_member } from "@relayroom/db/auth-schema"

/**
 * Serve storage files.
 *
 * Authorization (REL-4): every request requires a session. Beyond that, access
 * is scoped by what the key structure tells us (see lib/storage/local.ts for the
 * two shapes the upload route produces):
 *   - `project/<projectId>/...`  → caller must be a member of that project's org.
 *   - `upload/<userId>/...`      → pre-project staging area; only the uploading
 *                                  user (or an admin) may read it back.
 *   - anything else              → deny. The upload route never produces other
 *                                  shapes, so an unrecognized prefix is either a
 *                                  stale/foreign key or a probing attempt.
 *
 * This does not implement true per-project ACLs (a project has no separate
 * "media visible to X" list — visibility is "any org member"), but it closes the
 * unauthenticated/cross-org read that existed before. Tighten further if a future
 * asset kind needs finer-grained (e.g. per-user-private) visibility.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key: segments } = await params
  const key = segments.join("/")

  const session = await getServerSession()
  if (!session) {
    return new NextResponse(null, { status: 401 })
  }

  const authorized = await isAuthorizedForKey(key, session.user.id)
  if (!authorized) {
    return new NextResponse(null, { status: 403 })
  }

  const storage = getStorage()
  const file = await storage.get(key)

  if (!file) {
    return new NextResponse(null, { status: 404 })
  }

  const fileName = segments[segments.length - 1] ?? "file"

  return new NextResponse(file.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.length),
      // Never let the browser sniff away from the declared Content-Type.
      "X-Content-Type-Options": "nosniff",
      // Render inline (it's an image meant to be displayed), but still name the
      // file so a "Save As" doesn't fall back to an unhelpful default.
      "Content-Disposition": `inline; filename="${sanitizeFileName(fileName)}"`,
      // Contains authorization-gated content now, so it must not be cached in
      // shared/proxy caches. Browser-local caching is still fine (content-addressed
      // keys never change contents), so we don't need `no-store`.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  })
}

/** Strip characters that could break out of the quoted Content-Disposition filename. */
function sanitizeFileName(name: string): string {
  return name.replace(/["\r\n]/g, "_")
}

async function isAuthorizedForKey(key: string, userId: string): Promise<boolean> {
  const segments = key.split("/")

  if (segments[0] === "project" && segments.length >= 2) {
    const projectId = segments[1]
    const [project] = await db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
    if (!project) return false

    // Query membership directly (rather than lib/auth-session's isOrgMember,
    // which re-derives the caller from request-scoped headers()) since we
    // already resolved the caller's userId above.
    const [member] = await db
      .select({ id: better_auth_member.id })
      .from(better_auth_member)
      .where(
        and(
          eq(better_auth_member.organizationId, project.organizationId),
          eq(better_auth_member.userId, userId),
        ),
      )
      .limit(1)
    return !!member
  }

  if (segments[0] === "upload" && segments.length >= 2) {
    const ownerId = segments[1]
    return ownerId === userId
  }

  // Unrecognized key shape — deny by default.
  return false
}
