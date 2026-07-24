"use server"

import { randomBytes } from "node:crypto"
import { and, eq } from "drizzle-orm"
import type { ApiResult, ApiResultWithItem } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { projects, knowledgeCheckMap, knowledgeAudits, knowledge } from "@relayroom/db/schema"
import { getServerSession, requireProjectAccess } from "@/lib/auth-session"
import { getErrorTranslations } from "@/lib/action-i18n"
import {
  addCheckMappingSchema,
  isRotationMode,
  type AddCheckMappingInput,
  type RotationMode,
} from "./attest-schema"
import { isUuid } from "@/lib/uuid"

/**
 * How long the rotated-away secret keeps verifying after a rotation.
 *
 * A grace window exists so a routine rotation does not break the CI configs that
 * still carry the old secret the instant the owner clicks. 24h is enough for an
 * owner to roll the secret across their pipelines and short enough to bound how
 * long a replaced secret stays usable.
 *
 * CHOSEN, NOT SPECIFIED: the design says `now() + grace` without a number. 24h is
 * a judgement, not a value from the spec - do not read it as one. Move it to
 * projects.knowledgeConfig if it ever needs to be per-project.
 *
 * The tradeoff cuts the other way when the secret leaked, where any grace is
 * exposure - that is what the `revoke` mode is for. This constant is the grace
 * for the `hygiene` mode only.
 */
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000

/** The plaintext secret, returned exactly once - the mint response and nowhere else. */
export interface MintedAttestSecret {
  /** Show this to the user once, then it is unrecoverable. */
  secret: string
  /** The public selector for this secret. Safe to display afterwards. */
  keyId: string
}

function newSecret(): string {
  // 32 bytes of entropy, hex. This is an HMAC key, never shown after the mint.
  return randomBytes(32).toString("hex")
}

function newKeyId(): string {
  // A short, public identifier the attest body names to select this key.
  return `k_${randomBytes(4).toString("hex")}`
}

/**
 * Mint the project's first attest secret, or rotate to a new one.
 *
 * The plaintext secret is in the RETURN VALUE and written nowhere a read can
 * reach - see attest-queries. There is intentionally no "show me the secret
 * again" path; the owner copies it now or mints a new one.
 *
 * Rotation is the documented two-slot move (04): the current secret becomes the
 * previous, honored for a grace window, and a fresh current is minted. On the
 * first mint there is no current, so no previous is set. Either way it is
 * `owner`-only and writes an `attest_secret_rotate` audit row - it is an entry
 * in the same ledger promotion writes to, and it cannot be undone.
 *
 * `mode` decides what happens to the secret being replaced:
 *
 * - `hygiene` (default) keeps it alive for ROTATION_GRACE_MS so running pipelines
 *   survive the swap.
 * - `revoke` clears the previous slot in the SAME write, so the replaced secret
 *   stops verifying immediately. The server's key selection requires a non-null,
 *   unexpired previous slot, so nulling the column is the whole revocation - there
 *   is no second place the old secret could still be honored from.
 *
 * What revoke does NOT do: it stops future misuse only. Promotions the leaked
 * secret already caused stay exactly as they are - undoing those is forensics,
 * through the existing refute/demote path. The UI says so; do not let this action
 * be presented as cleanup of the past.
 */
export async function rotateAttestSecret(
  projectId: string,
  mode: RotationMode = "hygiene",
): Promise<ApiResultWithItem<MintedAttestSecret>> {
  const t = await getErrorTranslations()
  try {
    if (!isUuid(projectId)) return { result: false, message: t("project.notFound") }
    // A Server Action's arguments are caller-supplied. An unrecognized mode is
    // refused rather than defaulted: silently reading an unknown value as
    // `hygiene` would leave a secret the owner believes they revoked alive for a
    // day, while the UI reported success.
    if (!isRotationMode(mode)) return { result: false, message: t("common.invalidInput") }

    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    // `owner`, not `write`: the secret is the root of CI's authority to promote.
    // The action re-checks even though the page hides the control - a Server
    // Action is a live endpoint reachable without the page.
    const access = await requireProjectAccess(session.user.id, projectId, "owner")
    if (!access.ok) return { result: false, message: access.message }

    const secret = newSecret()
    const keyId = newKeyId()

    const minted = await db.transaction(async (tx) => {
      // Read the current slot under the row so a concurrent rotation cannot
      // interleave and lose one side of the copy.
      const [current] = await tx
        .select({
          secret: projects.attestSecret,
          keyId: projects.attestKeyId,
        })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("update")
      if (!current) return null

      const rotating = current.secret != null
      // `revoke` keeps no previous at all - not a shorter grace, none. Anything
      // else would leave a window on a secret assumed compromised.
      const keepsPrev = rotating && mode === "hygiene"
      const graceUntil = keepsPrev ? new Date(Date.now() + ROTATION_GRACE_MS) : null

      await tx
        .update(projects)
        .set({
          attestSecret: secret,
          attestKeyId: keyId,
          // Current -> previous, honored for the grace window. On a first mint
          // (no current) and on a revoke, the previous slot is left empty.
          attestSecretPrev: keepsPrev ? current.secret : null,
          attestKeyIdPrev: keepsPrev ? current.keyId : null,
          attestSecretPrevExpiresAt: graceUntil,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId))

      await tx.insert(knowledgeAudits).values({
        projectId,
        action: "attest_secret_rotate",
        actorKind: "human",
        actorUserId: session.user.id,
        // The plaintext is never recorded; the audit names the key ids and whether
        // this replaced a live secret, which is what an operator needs to trace it.
        // `reason` separates a routine rotation from an incident response, and
        // `graceUntil` records whether the replaced key was left usable - the two
        // things a later forensic read needs and cannot infer from the row itself.
        detail: {
          keyId,
          prevKeyId: rotating ? current.keyId : null,
          firstMint: !rotating,
          reason: mode === "revoke" ? "incident" : "hygiene",
          revokedPrev: rotating && mode === "revoke",
          graceUntil: graceUntil?.toISOString() ?? null,
        },
      })

      return true
    })

    if (!minted) return { result: false, message: t("project.notFound") }
    return { result: true, item: { secret, keyId } }
  } catch (err) {
    console.error("[rotateAttestSecret]", err)
    return { result: false, message: t("attest.rotateFailed") }
  }
}

/**
 * Map a CI check to a claim, so a passing run of that check counts toward the
 * claim's promotion. Without a mapping an attestation is recorded `counted=false`
 * and never promotes, so this screen is where an owner decides what CI may vouch
 * for.
 *
 * The (project, knowledge) pairing is enforced two ways: the claim is confirmed
 * to belong to THIS project before the insert, and the table's composite FK
 * rejects a cross-project pair even if that check were bypassed.
 */
export async function addCheckMapping(input: AddCheckMappingInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    const parsed = addCheckMappingSchema(t).safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const { projectId, knowledgeId, checkName } = parsed.data

    const access = await requireProjectAccess(session.user.id, projectId, "owner")
    if (!access.ok) return { result: false, message: access.message }

    // The claim must belong to this project. This is the tenant check in
    // application terms; the composite FK is the backstop, not the primary gate.
    const [entry] = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(eq(knowledge.id, knowledgeId), eq(knowledge.projectId, projectId)))
      .limit(1)
    if (!entry) return { result: false, message: t("knowledge.notFound") }

    await db
      .insert(knowledgeCheckMap)
      .values({ projectId, checkName, knowledgeId, createdByUserId: session.user.id })
      // The unique index makes a duplicate mapping a no-op rather than an error.
      .onConflictDoNothing()

    await db.insert(knowledgeAudits).values({
      projectId,
      action: "check_map_change",
      knowledgeId,
      actorKind: "human",
      actorUserId: session.user.id,
      detail: { change: "add", checkName },
    })

    return { result: true }
  } catch (err) {
    console.error("[addCheckMapping]", err)
    return { result: false, message: t("attest.mapFailed") }
  }
}

/** Remove a check -> claim mapping. Owner-only; audited. */
export async function removeCheckMapping(mappingId: string): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    if (!isUuid(mappingId)) return { result: false, message: t("attest.mappingNotFound") }

    const session = await getServerSession()
    if (!session) return { result: false, message: t("auth.loginRequired") }

    // Resolve the mapping's project first so authority is checked against the
    // project that owns it, not one the caller supplies.
    const [mapping] = await db
      .select({ projectId: knowledgeCheckMap.projectId, checkName: knowledgeCheckMap.checkName, knowledgeId: knowledgeCheckMap.knowledgeId })
      .from(knowledgeCheckMap)
      .where(eq(knowledgeCheckMap.id, mappingId))
      .limit(1)
    if (!mapping) return { result: false, message: t("attest.mappingNotFound") }

    const access = await requireProjectAccess(session.user.id, mapping.projectId, "owner")
    if (!access.ok) return { result: false, message: access.message }

    await db.delete(knowledgeCheckMap).where(eq(knowledgeCheckMap.id, mappingId))

    await db.insert(knowledgeAudits).values({
      projectId: mapping.projectId,
      action: "check_map_change",
      knowledgeId: mapping.knowledgeId,
      actorKind: "human",
      actorUserId: session.user.id,
      detail: { change: "remove", checkName: mapping.checkName },
    })

    return { result: true }
  } catch (err) {
    console.error("[removeCheckMapping]", err)
    return { result: false, message: t("attest.mapFailed") }
  }
}
