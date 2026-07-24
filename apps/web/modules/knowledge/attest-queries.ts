import { and, eq, desc } from "drizzle-orm"
import { db } from "@/modules/drizzle/db"
import { projects, knowledgeCheckMap, knowledge } from "@relayroom/db/schema"

// ── Attest status ─────────────────────────────────────────────────────────────

/**
 * What the settings screen may know about a project's attest secret.
 *
 * The plaintext secret is NOT here, and there is no query anywhere that returns
 * it. It exists in one place at one moment - the response of the action that
 * mints it - and never again. That is the point: a credential that can be read
 * back is a credential that leaks, so the read path is built so the value simply
 * is not on it. Only the key id (a public selector, safe to show) and whether a
 * previous key is still in its grace window are exposed.
 */
export interface AttestStatus {
  /** null = attestation disabled: no secret has ever been minted. */
  keyId: string | null
  /** The rotated-away key's id, while it is still honored. null once expired/absent. */
  prevKeyId: string | null
  /** When the previous key stops verifying. null when there is no live previous key. */
  prevExpiresAt: Date | null
}

export async function getAttestStatus(projectId: string): Promise<AttestStatus> {
  const [row] = await db
    .select({
      keyId: projects.attestKeyId,
      prevKeyId: projects.attestKeyIdPrev,
      prevExpiresAt: projects.attestSecretPrevExpiresAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)

  if (!row) return { keyId: null, prevKeyId: null, prevExpiresAt: null }

  // A previous key past its expiry is not live even if the sweep has not nulled it
  // yet, so it is reported as absent rather than as a key still in grace.
  const prevLive = row.prevExpiresAt != null && row.prevExpiresAt.getTime() > Date.now()
  return {
    keyId: row.keyId,
    prevKeyId: prevLive ? row.prevKeyId : null,
    prevExpiresAt: prevLive ? row.prevExpiresAt : null,
  }
}

// ── Check map ─────────────────────────────────────────────────────────────────

export interface CheckMappingRow {
  id: string
  checkName: string
  knowledgeId: string
  /** The mapped claim's title, so the list reads as claims, not raw ids. */
  knowledgeTitle: string
  knowledgeKind: string
  knowledgeState: string
  createdAt: Date
}

/**
 * The check -> claim mappings for a project, each joined to its claim so the row
 * is legible. Scoped to the project; the join to knowledge is on BOTH project and
 * id, mirroring the composite FK, so a stray mapping could never surface another
 * project's claim.
 */
export async function listCheckMappings(projectId: string): Promise<CheckMappingRow[]> {
  return db
    .select({
      id: knowledgeCheckMap.id,
      checkName: knowledgeCheckMap.checkName,
      knowledgeId: knowledgeCheckMap.knowledgeId,
      knowledgeTitle: knowledge.title,
      knowledgeKind: knowledge.kind,
      knowledgeState: knowledge.validationState,
      createdAt: knowledgeCheckMap.createdAt,
    })
    .from(knowledgeCheckMap)
    .innerJoin(
      knowledge,
      and(
        eq(knowledge.id, knowledgeCheckMap.knowledgeId),
        eq(knowledge.projectId, knowledgeCheckMap.projectId),
      ),
    )
    .where(eq(knowledgeCheckMap.projectId, projectId))
    .orderBy(desc(knowledgeCheckMap.createdAt))
}
