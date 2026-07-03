/**
 * REL-3 regression: sharp pixel-bomb DoS guard + Content-Length pre-check on the
 * media upload route. A malicious/misconfigured client could otherwise submit a
 * tiny file whose header declares an enormous pixel count (decode-time memory/CPU
 * blowup) or a body far larger than we intend to buffer before validation.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import * as zlib from "node:zlib"

let actingUserId = "upload-actor"

vi.mock("@/lib/auth-session", () => ({
  getServerSession: vi.fn(async () => ({ user: { id: actingUserId } })),
}))

// The local filesystem storage driver is irrelevant to what these tests exercise
// (sharp pixel-limit + Content-Length guards), so stub it out rather than
// touching disk.
vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => ({
    put: vi.fn(async () => {}),
    get: vi.fn(async () => null),
    url: vi.fn((key: string) => `/api/media/${key}`),
  })),
}))

import { db } from "@/lib/db"
import { better_auth_user } from "@relayroom/db/auth-schema"
import { POST } from "./route"

// ── PNG fixture builders ────────────────────────────────────────────────────

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(typeAndData) >>> 0, 0)
  return Buffer.concat([len, typeAndData, crc])
}

/**
 * A syntactically-valid-enough PNG whose IHDR declares an enormous width/height
 * (a "pixel bomb"). libvips reads IHDR before decoding raster data, so this is
 * tiny on the wire but claims a huge decoded pixel count.
 */
function buildPixelBombPng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const idat = zlib.deflateSync(Buffer.alloc(0))
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))])
}

/** A tiny valid 1x1 RGBA PNG (real pixel data, decodes cleanly). */
function buildTinyPng(): Buffer {
  const raw = Buffer.from([0, 255, 0, 0, 255]) // filter byte 0 + one RGBA pixel
  const idat = zlib.deflateSync(raw)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))])
}

function makeUploadRequest(opts: {
  file: Buffer
  fileName?: string
  mimeType?: string
  contentLengthOverride?: number
}): Request {
  const form = new FormData()
  const blob = new Blob([opts.file as unknown as BlobPart], {
    type: opts.mimeType ?? "image/png",
  })
  form.append("file", blob, opts.fileName ?? "test.png")
  form.append("kind", "thumbnail")

  const req = new Request("http://localhost/api/media/upload", {
    method: "POST",
    body: form,
  })

  if (opts.contentLengthOverride !== undefined) {
    req.headers.set("content-length", String(opts.contentLengthOverride))
  }

  return req
}

beforeEach(async () => {
  actingUserId = "upload-actor"
  await db
    .insert(better_auth_user)
    .values({
      id: actingUserId,
      name: actingUserId,
      email: `${actingUserId}@test.local`,
      emailVerified: true,
    })
    .onConflictDoNothing()
})

afterAll(async () => {
  await db.$client.end()
})

describe("POST /api/media/upload — REL-3 pixel-bomb + Content-Length guards", () => {
  it("rejects a pixel-bomb PNG (huge declared dimensions) with 422", async () => {
    const bomb = buildPixelBombPng(100_000, 100_000)
    const req = makeUploadRequest({ file: bomb })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.result).toBe(false)
  })

  it("accepts a well-formed small PNG", async () => {
    const tiny = buildTinyPng()
    const req = makeUploadRequest({ file: tiny })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.result).toBe(true)
    expect(body.item.key).toMatch(/^upload\//)
  })

  it("rejects a request whose Content-Length header already exceeds the max with 413, before buffering", async () => {
    // The actual body can be small — what matters is that the route inspects the
    // declared Content-Length BEFORE calling req.formData() and short-circuits.
    const small = buildTinyPng()
    const req = makeUploadRequest({
      file: small,
      contentLengthOverride: 50 * 1024 * 1024, // 50 MB declared
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any)
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.result).toBe(false)
  })

  it("rejects an oversized actual file body with 413 (post-parse size check still holds)", async () => {
    // 6 MB of random bytes wrapped as a PNG-mime blob — too big regardless of
    // Content-Length pre-check behavior on this runtime.
    const big = randomBytes(6 * 1024 * 1024)
    const req = makeUploadRequest({ file: big })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any)
    expect(res.status).toBe(413)
  })
})

// Sanity: fixtures actually hash differently (guards against a copy-paste bug
// where both fixtures resolve to the same bytes).
describe("fixture sanity", () => {
  it("pixel-bomb and tiny PNG fixtures are distinct", () => {
    const a = createHash("sha256").update(buildPixelBombPng(100_000, 100_000)).digest("hex")
    const b = createHash("sha256").update(buildTinyPng()).digest("hex")
    expect(a).not.toBe(b)
  })
})
