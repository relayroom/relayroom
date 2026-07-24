/**
 * CI attestation management (FEAT-0001 L1): secret rotation and check mapping.
 *
 * Two invariants carry the weight. First, the secret is owner-only and shown
 * once - so the negative cases are exercised by calling the action, not by
 * checking which button renders, and a test asserts no read path returns the
 * plaintext. Second, a mapping is what makes a CI attestation count; the mapping
 * write is what this screen exists to control, so it and its tenant boundary are
 * pinned.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"

let actingUserId = "at-owner"

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>()
  return {
    ...actual, // keep the REAL requireProjectAccess
    getServerSession: vi.fn(async () => ({ user: { id: actingUserId } })),
  }
})

import { db } from "@/lib/db"
import {
  projects,
  projectAccess,
  knowledge,
  knowledgeCheckMap,
  knowledgeAudits,
} from "@relayroom/db/schema"
import { better_auth_user, better_auth_organization, better_auth_member } from "@relayroom/db/auth-schema"
import { rotateAttestSecret, addCheckMapping, removeCheckMapping } from "./attest-actions"
import { getAttestStatus, listCheckMappings } from "./attest-queries"

const ORG = "org-at"
const OWNER = "at-owner"
const WRITER = "at-writer"
const OUTSIDER = "at-outsider"

let projectId: string
let otherProjectId: string
let claimId: string
let foreignClaimId: string

async function seedMember(org: string, id: string, role: string) {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
  await db
    .insert(better_auth_member)
    .values({ id: `m-${org}-${id}`, organizationId: org, userId: id, role, createdAt: new Date() })
    .onConflictDoNothing()
}

async function addClaim(pid: string): Promise<string> {
  const [row] = await db
    .insert(knowledge)
    .values({ projectId: pid, kind: "fact", title: "a claim", body: "b", sourceKind: "learn" })
    .returning({ id: knowledge.id })
  return row!.id
}

async function rawSecret(pid: string) {
  const [row] = await db
    .select({
      secret: projects.attestSecret,
      keyId: projects.attestKeyId,
      prevSecret: projects.attestSecretPrev,
      prevKeyId: projects.attestKeyIdPrev,
      prevExp: projects.attestSecretPrevExpiresAt,
    })
    .from(projects)
    .where(eq(projects.id, pid))
  return row!
}

async function auditsFor(pid: string, action: string) {
  return db
    .select({ action: knowledgeAudits.action, actor: knowledgeAudits.actorUserId, detail: knowledgeAudits.detail })
    .from(knowledgeAudits)
    .where(eq(knowledgeAudits.projectId, pid))
    .then((rows) => rows.filter((r) => r.action === action))
}

beforeEach(async () => {
  actingUserId = OWNER
  await db.delete(knowledgeCheckMap)
  await db.delete(knowledge)
  await db.delete(projectAccess)
  for (const org of [ORG, "org-at-other"]) {
    await db.delete(projects).where(eq(projects.organizationId, org))
    await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, org))
    await db.insert(better_auth_organization).values({ id: org, name: org, createdAt: new Date() }).onConflictDoNothing()
  }
  await seedMember(ORG, OWNER, "member")
  await seedMember(ORG, WRITER, "member")
  await seedMember("org-at-other", OUTSIDER, "owner")

  const [p] = await db
    .insert(projects)
    .values({ organizationId: ORG, slug: "at", name: "AT", connectCode: "at-cc", createdByUserId: OWNER })
    .returning({ id: projects.id })
  projectId = p!.id
  const [other] = await db
    .insert(projects)
    .values({ organizationId: "org-at-other", slug: "at-o", name: "ATO", connectCode: "at-cc-o", createdByUserId: OUTSIDER })
    .returning({ id: projects.id })
  otherProjectId = other!.id

  await db.insert(projectAccess).values([
    { projectId, userId: OWNER, level: "owner", createdByUserId: OWNER },
    { projectId, userId: WRITER, level: "write", createdByUserId: OWNER },
  ])

  claimId = await addClaim(projectId)
  foreignClaimId = await addClaim(otherProjectId)
})

afterAll(async () => {
  await db.$client.end()
})

describe("rotateAttestSecret", () => {
  it("first mint sets current, no previous, and audits", async () => {
    const res = await rotateAttestSecret(projectId)
    expect(res.result).toBe(true)
    if (!res.result) return

    const row = await rawSecret(projectId)
    expect(row.secret).toBe(res.item.secret)   // stored equals what was shown, once
    expect(row.keyId).toBe(res.item.keyId)
    expect(row.prevSecret).toBeNull()           // nothing to roll on a first mint
    expect(row.prevExp).toBeNull()

    const audits = await auditsFor(projectId, "attest_secret_rotate")
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toMatchObject({ firstMint: true })
  })

  it("rotation moves current into the previous slot with a grace expiry", async () => {
    const first = await rotateAttestSecret(projectId)
    expect(first.result).toBe(true)
    if (!first.result) return
    const before = await rawSecret(projectId)

    const second = await rotateAttestSecret(projectId)
    expect(second.result).toBe(true)
    if (!second.result) return

    const after = await rawSecret(projectId)
    expect(after.secret).toBe(second.item.secret)
    expect(after.secret).not.toBe(before.secret)
    expect(after.prevSecret).toBe(before.secret)     // old current -> previous
    expect(after.prevKeyId).toBe(before.keyId)
    expect(after.prevExp).not.toBeNull()
    expect(after.prevExp!.getTime()).toBeGreaterThan(Date.now())

    expect(await auditsFor(projectId, "attest_secret_rotate")).toHaveLength(2)
  })

  it("refuses a write grant", async () => {
    actingUserId = WRITER
    const res = await rotateAttestSecret(projectId)
    expect(res.result).toBe(false)
    expect((await rawSecret(projectId)).secret).toBeNull()   // nothing minted
    expect(await auditsFor(projectId, "attest_secret_rotate")).toHaveLength(0)
  })

  it("refuses a member of another org", async () => {
    actingUserId = OUTSIDER
    const res = await rotateAttestSecret(projectId)
    expect(res.result).toBe(false)
  })
})

describe("the plaintext secret is never on a read path", () => {
  it("getAttestStatus exposes the key id but not the secret", async () => {
    await rotateAttestSecret(projectId)
    const status = await getAttestStatus(projectId)
    // The shape itself has no secret field, and nothing here equals it.
    expect(Object.keys(status)).toEqual(["keyId", "prevKeyId", "prevExpiresAt"])
    expect(JSON.stringify(status)).not.toContain(
      (await rawSecret(projectId)).secret as string,
    )
    expect(status.keyId).not.toBeNull()
  })

  it("reports an expired previous key as absent", async () => {
    await rotateAttestSecret(projectId)
    await rotateAttestSecret(projectId)
    // Force the grace window into the past.
    await db
      .update(projects)
      .set({ attestSecretPrevExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(projects.id, projectId))

    const status = await getAttestStatus(projectId)
    expect(status.prevKeyId).toBeNull()
    expect(status.prevExpiresAt).toBeNull()
  })
})

describe("check mapping", () => {
  it("owner maps a check to a claim, and it is what makes an attestation countable", async () => {
    const res = await addCheckMapping({ projectId, knowledgeId: claimId, checkName: "migration-smoke" })
    expect(res.result).toBe(true)

    const mappings = await listCheckMappings(projectId)
    expect(mappings).toHaveLength(1)
    expect(mappings[0]).toMatchObject({ checkName: "migration-smoke", knowledgeId: claimId })

    // The counting rule downstream is EXISTS(map row) - so the presence of this
    // row is exactly what flips an attestation to counted. Asserting the row
    // exists for (project, check, claim) is asserting that.
    const [mapRow] = await db
      .select({ n: knowledgeCheckMap.id })
      .from(knowledgeCheckMap)
      .where(eq(knowledgeCheckMap.knowledgeId, claimId))
    expect(mapRow).toBeDefined()

    expect(await auditsFor(projectId, "check_map_change")).toHaveLength(1)
  })

  it("is idempotent: mapping the same pair twice leaves one row", async () => {
    await addCheckMapping({ projectId, knowledgeId: claimId, checkName: "smoke" })
    await addCheckMapping({ projectId, knowledgeId: claimId, checkName: "smoke" })
    expect(await listCheckMappings(projectId)).toHaveLength(1)
  })

  it("refuses a write grant", async () => {
    actingUserId = WRITER
    const res = await addCheckMapping({ projectId, knowledgeId: claimId, checkName: "smoke" })
    expect(res.result).toBe(false)
    expect(await listCheckMappings(projectId)).toHaveLength(0)
  })

  it("will not map another project's claim, even for this project's owner", async () => {
    const res = await addCheckMapping({ projectId, knowledgeId: foreignClaimId, checkName: "smoke" })
    expect(res.result).toBe(false)
    expect(await listCheckMappings(projectId)).toHaveLength(0)
    // Rejected by the app-level tenant check (a clean not-found), not by hitting
    // the composite FK and surfacing as a caught write error. The FK is the
    // backstop; if this ever reads "could not update", the primary gate is gone
    // and cross-project attempts are taking the 500-shaped path.
    if (!res.result) {
      const t = await import("@/lib/action-i18n").then((m) => m.getErrorTranslations())
      expect(res.message).toBe(t("knowledge.notFound"))
    }
  })

  it("removes a mapping, owner-only and audited", async () => {
    await addCheckMapping({ projectId, knowledgeId: claimId, checkName: "smoke" })
    const [m] = await listCheckMappings(projectId)

    actingUserId = WRITER
    expect((await removeCheckMapping(m!.id)).result).toBe(false)
    expect(await listCheckMappings(projectId)).toHaveLength(1)

    actingUserId = OWNER
    expect((await removeCheckMapping(m!.id)).result).toBe(true)
    expect(await listCheckMappings(projectId)).toHaveLength(0)
    expect(await auditsFor(projectId, "check_map_change")).toHaveLength(2) // add + remove
  })
})
