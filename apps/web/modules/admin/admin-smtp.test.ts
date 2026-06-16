/**
 * Web tests for the instance-superuser SMTP admin flow.
 *
 * Two concerns:
 *  1. The query layer: isInstanceSuperuser (earliest-created user only),
 *     getSmtpConfig (hasPassword boolean, never the raw password), and the
 *     blank-password-preserves-stored-secret behaviour through saveSmtpConfig.
 *  2. The SMTP resolver in lib/email.ts: resolveSmtpFromValue and resolveSmtp
 *     preferring DB config over env.
 *
 * The earliest-created user is global state, so isInstanceSuperuser is verified
 * by inserting a user at the UNIX epoch (guaranteed earliest) and asserting it
 * resolves to that user; for the action tests the queries module is mocked so we
 * control who the superuser is deterministically.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { and, eq, isNull } from "drizzle-orm"

let actingUserId: string | null = "smtp-super"
let actingEmail: string | null = "smtp-super@test.local"
let mockIsSuperuser = true

vi.mock("@/lib/auth-session", () => ({
  getServerSession: vi.fn(async () =>
    actingUserId ? { user: { id: actingUserId, email: actingEmail } } : null,
  ),
}))

// Mock only isInstanceSuperuser so action tests are deterministic; the real
// getSmtpConfigRaw still runs against the DB (so the blank-password preserve
// path is exercised for real).
vi.mock("./queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queries")>()
  return { ...actual, isInstanceSuperuser: vi.fn(async () => mockIsSuperuser) }
})

// sendMailWith is mocked so sendTestEmail never opens a real SMTP socket.
const sentMail: Array<{ to: string; subject: string }> = []
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>()
  return {
    ...actual,
    sendMailWith: vi.fn(async (_smtp: unknown, opts: { to: string; subject: string }) => {
      sentMail.push({ to: opts.to, subject: opts.subject })
    }),
  }
})

import { db } from "@/lib/db"
import { configurations } from "@relayroom/db/schema"
import { better_auth_user } from "@relayroom/db/auth-schema"
import { saveSmtpConfig, sendTestEmail } from "./actions"
import { getSmtpConfig, getSmtpConfigRaw, getInstanceSuperuserId } from "./queries"
import { resolveSmtpFromValue, resolveSmtp } from "@/lib/email"

// The real (unmocked) isInstanceSuperuser, imported via the dynamic original so
// the module mock above (which stubs isInstanceSuperuser for the action tests)
// does not shadow it here.
async function realIsSuperuser(userId: string): Promise<boolean> {
  const actual = await vi.importActual<typeof import("./queries")>("./queries")
  return actual.isInstanceSuperuser(userId)
}

async function deleteSmtpConfig(): Promise<void> {
  await db
    .delete(configurations)
    .where(
      and(
        eq(configurations.scope, "global"),
        isNull(configurations.scopeId),
        eq(configurations.key, "smtp"),
      ),
    )
}

beforeEach(async () => {
  actingUserId = "smtp-super"
  actingEmail = "smtp-super@test.local"
  mockIsSuperuser = true
  sentMail.length = 0
  await db
    .insert(better_auth_user)
    .values({ id: "smtp-super", name: "Super", email: "smtp-super@test.local", emailVerified: true })
    .onConflictDoNothing()
  await deleteSmtpConfig()
})

afterEach(async () => {
  await deleteSmtpConfig()
})

afterAll(async () => {
  await db.$client.end()
})

describe("isInstanceSuperuser (real resolver)", () => {
  it("resolves to the earliest-created user only", async () => {
    // Insert a user pinned at the UNIX epoch - guaranteed to be the earliest.
    const epochUser = "smtp-epoch-user"
    await db
      .insert(better_auth_user)
      .values({
        id: epochUser,
        name: "Epoch",
        email: "epoch@test.local",
        emailVerified: true,
        createdAt: new Date(0),
      })
      .onConflictDoNothing()

    const superId = await getInstanceSuperuserId()
    expect(superId).toBe(epochUser)
    expect(await realIsSuperuser(epochUser)).toBe(true)
    // A later user is not the superuser.
    expect(await realIsSuperuser("smtp-super")).toBe(false)
    // Empty id short-circuits to false.
    expect(await realIsSuperuser("")).toBe(false)

    await db.delete(better_auth_user).where(eq(better_auth_user.id, epochUser))
  })
})

describe("saveSmtpConfig", () => {
  it("rejects a non-superuser", async () => {
    mockIsSuperuser = false
    const res = await saveSmtpConfig({ host: "smtp.example.com", port: 587, pass: "secret" })
    expect(res.result).toBe(false)
    expect(await getSmtpConfigRaw()).toBeNull()
  })

  it("rejects an unauthenticated caller", async () => {
    actingUserId = null
    const res = await saveSmtpConfig({ host: "smtp.example.com", port: 587, pass: "secret" })
    expect(res.result).toBe(false)
  })

  it("superuser saves config; getSmtpConfig exposes hasPassword, never the secret", async () => {
    const res = await saveSmtpConfig({
      host: "smtp.example.com",
      port: 465,
      user: "mailer",
      pass: "topsecret",
      from: "noreply@example.com",
      encryption: "ssl",
    })
    expect(res.result).toBe(true)

    const view = await getSmtpConfig()
    expect(view).toBeTruthy()
    expect(view!.host).toBe("smtp.example.com")
    expect(view!.port).toBe(465)
    expect(view!.user).toBe("mailer")
    expect(view!.from).toBe("noreply@example.com")
    expect(view!.encryption).toBe("ssl")
    expect(view!.hasPassword).toBe(true)
    // The view must NOT carry the raw secret in any field.
    expect(JSON.stringify(view)).not.toContain("topsecret")
  })

  it("getSmtpConfig.hasPassword is false when no password stored", async () => {
    await saveSmtpConfig({ host: "smtp.example.com", port: 587, pass: "" })
    const view = await getSmtpConfig()
    expect(view!.hasPassword).toBe(false)
  })

  it("blank password on edit preserves the stored secret", async () => {
    await saveSmtpConfig({ host: "smtp.example.com", port: 587, pass: "keepme" })
    // Edit other fields, leaving password blank: the action reads the stored
    // secret and writes it back so the new value object still carries it.
    const res = await saveSmtpConfig({ host: "smtp2.example.com", port: 2525, pass: "" })
    expect(res.result).toBe(true)

    // Inspect the persisted global SMTP row(s) directly. The edited row carries
    // the new host AND the preserved secret (blank input did not wipe it).
    const rows = await db
      .select({ value: configurations.value })
      .from(configurations)
      .where(
        and(
          eq(configurations.scope, "global"),
          isNull(configurations.scopeId),
          eq(configurations.key, "smtp"),
        ),
      )
    const edited = rows
      .map((r) => r.value as { host?: string; port?: number; pass?: string })
      .find((v) => v.host === "smtp2.example.com")
    expect(edited).toBeTruthy()
    expect(edited!.port).toBe(2525)
    expect(edited!.pass).toBe("keepme")
  })
})

describe("sendTestEmail", () => {
  it("non-superuser is rejected, no mail sent", async () => {
    mockIsSuperuser = false
    const res = await sendTestEmail({ host: "smtp.example.com", port: 587, pass: "x" })
    expect(res.result).toBe(false)
    expect(sentMail).toHaveLength(0)
  })

  it("superuser sends a test mail to their own address", async () => {
    const res = await sendTestEmail({ host: "smtp.example.com", port: 587, user: "u", pass: "p" })
    expect(res.result).toBe(true)
    expect(sentMail).toHaveLength(1)
    expect(sentMail[0]!.to).toBe("smtp-super@test.local")
  })
})

describe("resolveSmtpFromValue (lib/email)", () => {
  it("returns null when host is blank", () => {
    expect(
      resolveSmtpFromValue({ host: "", port: 587, user: "", pass: "", from: "", secure: false, encryption: "starttls" }),
    ).toBeNull()
  })

  it("fills defaults: port 587, derived from address, drops blank user/pass", () => {
    const r = resolveSmtpFromValue({ host: "mail.host", port: 0, user: "", pass: "", from: "", secure: false, encryption: "starttls" })
    expect(r).toBeTruthy()
    expect(r!.port).toBe(587)
    expect(r!.from).toBe("noreply@mail.host")
    expect(r!.user).toBeUndefined()
    expect(r!.pass).toBeUndefined()
  })

  it("keeps explicit user/pass/from/secure", () => {
    const r = resolveSmtpFromValue({
      host: "mail.host",
      port: 465,
      user: "u",
      pass: "p",
      from: "x@host",
      secure: true,
      encryption: "ssl",
    })
    expect(r!.user).toBe("u")
    expect(r!.pass).toBe("p")
    expect(r!.from).toBe("x@host")
    expect(r!.secure).toBe(true)
    expect(r!.port).toBe(465)
  })
})

describe("resolveSmtp prefers DB config over env", () => {
  const ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE"]
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("uses the DB row when present, ignoring env", async () => {
    process.env.SMTP_HOST = "env.host"
    process.env.SMTP_PORT = "25"
    await saveSmtpConfig({ host: "db.host", port: 587, user: "dbu", pass: "dbp" })
    const r = await resolveSmtp()
    expect(r!.host).toBe("db.host")
  })

  it("falls back to env when no DB row exists", async () => {
    await deleteSmtpConfig()
    process.env.SMTP_HOST = "env.host"
    process.env.SMTP_PORT = "465"
    const r = await resolveSmtp()
    expect(r!.host).toBe("env.host")
    expect(r!.port).toBe(465)
    // Port 465 implies secure TLS.
    expect(r!.secure).toBe(true)
  })

  it("returns null when neither DB nor env is configured", async () => {
    await deleteSmtpConfig()
    for (const k of ENV_KEYS) delete process.env[k]
    const r = await resolveSmtp()
    expect(r).toBeNull()
  })
})
