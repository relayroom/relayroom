import { createHash } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import type { ApiResultWithItem } from "@relayroom/shared"

// Sharp is required at runtime via require() to avoid the ESM exports-map
// resolution issue with moduleResolution:bundler. The type cast retains full
// type safety without triggering the TS7016 "can't resolve via exports" error.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const sharp: (input: Buffer) => any = require("sharp")
import { and, eq } from "drizzle-orm"
import { getServerSession } from "@/lib/auth-session"
import { getStorage } from "@/lib/storage"
import { db } from "@/modules/drizzle/db"
import { projects } from "@relayroom/db/schema"
import { better_auth_member } from "@relayroom/db/auth-schema"

// ── Constants ─────────────────────────────────────────────────────────────────

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"])
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB

/** Max output dimension per kind (longest side). Sharp preserves aspect ratio. */
const KIND_MAX_PX: Record<string, number> = {
  thumbnail: 512,
  background: 1920,
}

/** Allowed `kind` values — these double as the storage-key prefix, so they must be a closed set. */
const ALLOWED_KINDS = new Set(Object.keys(KIND_MAX_PX))

/** Reject any path-control characters that could escape the intended key prefix. */
function hasPathChars(s: string): boolean {
  return s.includes("/") || s.includes("\\") || s.includes("..")
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Auth guard
  const session = await getServerSession()
  if (!session) {
    return NextResponse.json<ApiResultWithItem<never>>(
      { result: false, message: "로그인이 필요합니다." },
      { status: 401 },
    )
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json<ApiResultWithItem<never>>(
      { result: false, message: "multipart/form-data 파싱 실패." },
      { status: 400 },
    )
  }

  const file = formData.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json<ApiResultWithItem<never>>(
      { result: false, message: "file 필드가 없습니다." },
      { status: 400 },
    )
  }

  // Validate MIME
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json<ApiResultWithItem<never>>(
      { result: false, message: "지원하지 않는 이미지 형식입니다. (PNG, JPEG, WebP만 허용)" },
      { status: 415 },
    )
  }

  // Validate size
  if (file.size > MAX_BYTES) {
    return NextResponse.json<ApiResultWithItem<never>>(
      { result: false, message: "파일 크기가 5MB를 초과합니다." },
      { status: 413 },
    )
  }

  const kind = (formData.get("kind") as string | null) ?? "thumbnail"
  const projectId = (formData.get("projectId") as string | null) ?? null

  // ── Validate `kind` ──────────────────────────────────────────────────────────
  // `kind` is interpolated into the storage key, so it must be one of the closed
  // allowlist (the keys of KIND_MAX_PX). The hasPathChars check is belt-and-
  // suspenders against path traversal even though the allowlist already excludes it.
  if (!ALLOWED_KINDS.has(kind) || hasPathChars(kind)) {
    return NextResponse.json<ApiResultWithItem<never>>(
      { result: false, message: "지원하지 않는 이미지 종류입니다." },
      { status: 400 },
    )
  }

  // ── Validate `projectId` ─────────────────────────────────────────────────────
  // When present it is interpolated into the key, so it must look like a UUID and
  // contain no path-control characters before it touches the filesystem.
  if (projectId !== null) {
    if (!/^[0-9a-f-]{36}$/i.test(projectId) || hasPathChars(projectId)) {
      return NextResponse.json<ApiResultWithItem<never>>(
        { result: false, message: "잘못된 프로젝트 ID입니다." },
        { status: 400 },
      )
    }

    // ── IDOR guard ─────────────────────────────────────────────────────────────
    // Resolve the project's OWN organization, then confirm the caller is a member
    // of that org. Without this, any authenticated user could upload into another
    // org's project/<projectId>/ path by passing an arbitrary projectId.
    const [project] = await db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)

    if (!project) {
      return NextResponse.json<ApiResultWithItem<never>>(
        { result: false, message: "프로젝트를 찾을 수 없습니다." },
        { status: 404 },
      )
    }

    const [member] = await db
      .select({ id: better_auth_member.id })
      .from(better_auth_member)
      .where(
        and(
          eq(better_auth_member.organizationId, project.organizationId),
          eq(better_auth_member.userId, session.user.id),
        ),
      )
      .limit(1)

    if (!member) {
      return NextResponse.json<ApiResultWithItem<never>>(
        { result: false, message: "이 프로젝트에 업로드할 권한이 없습니다." },
        { status: 403 },
      )
    }
  }

  const maxPx = KIND_MAX_PX[kind]

  // Read bytes
  const inputBytes = Buffer.from(await file.arrayBuffer())

  // Process: resize, convert to WebP, strip EXIF metadata
  let outputBytes: Buffer
  try {
    outputBytes = await sharp(inputBytes)
      .resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      // withMetadata(false) is the default — metadata (incl. EXIF/GPS) is stripped
      .toBuffer()
  } catch (err) {
    console.error("[media/upload] sharp processing failed", err)
    return NextResponse.json<ApiResultWithItem<never>>(
      { result: false, message: "이미지 처리에 실패했습니다." },
      { status: 422 },
    )
  }

  // Content-hash filename (SHA-256 of processed bytes — deduplicates identical images)
  const hash = createHash("sha256").update(outputBytes).digest("hex").slice(0, 32)
  const fileName = `${kind}-${hash}.webp`

  // Key: project/<projectId>/<fileName> OR upload/<userId>/<fileName> if no projectId yet
  const key = projectId
    ? `project/${projectId}/${fileName}`
    : `upload/${session.user.id}/${fileName}`

  const storage = getStorage()

  try {
    await storage.put(key, outputBytes, "image/webp")
  } catch (err) {
    console.error("[media/upload] storage.put failed", err)
    return NextResponse.json<ApiResultWithItem<never>>(
      { result: false, message: "파일 저장에 실패했습니다." },
      { status: 500 },
    )
  }

  const url = storage.url(key)

  return NextResponse.json<ApiResultWithItem<{ key: string; url: string }>>(
    { result: true, item: { key, url } },
    { status: 201 },
  )
}
