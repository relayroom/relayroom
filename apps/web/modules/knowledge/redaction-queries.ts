import { eq } from "drizzle-orm"
import {
  DETECTOR_CATALOGUE,
  resolveRedactionRules,
  type RedactionRule,
  type UnresolvedRule,
} from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { projects } from "@relayroom/db/schema"

/**
 * What the redaction card needs to draw itself.
 *
 * `rules` is what is stored, shown so the owner can edit it. `unresolved` is what the
 * server would refuse, computed HERE with the same shared function the server uses -
 * not a second implementation of the same judgement. If the two ever disagreed, the
 * screen would tell an owner their configuration is fine while distillation is
 * stopped, which is worse than showing nothing.
 */
export interface RedactionSettings {
  /** Stored rules, in stored order. Malformed entries are kept so the owner can see
   *  and remove them rather than having them silently vanish from the editor. */
  rules: RedactionRule[]
  /** Non-empty means nothing is being distilled for this project right now. */
  unresolved: UnresolvedRule[]
  /** Detector ids whose saved version is not the newest we ship. */
  outdatedDetectorIds: string[]
  /** True while we ship no detectors at all - a deliberate state, not a missing UI. */
  catalogueEmpty: boolean
}

/** Newest version we ship for a detector, or null if we ship none. */
function newestVersion(id: string): number | null {
  const versions = Object.keys(DETECTOR_CATALOGUE[id] ?? {}).map(Number)
  return versions.length > 0 ? Math.max(...versions) : null
}

export async function getRedactionSettings(projectId: string): Promise<RedactionSettings> {
  const [row] = await db
    .select({ config: projects.knowledgeConfig })
    .from(projects)
    .where(eq(projects.id, projectId))

  const config = row?.config ?? {}
  const { unresolved } = resolveRedactionRules(config)

  // Read the stored value without asserting its shape. The column is JSONB, so a
  // typed view of it is a claim rather than a guarantee - the same reason the shared
  // resolver takes `unknown`. Anything that is not an array is shown as no rules; the
  // resolver has already reported it as unresolved, so the card says why.
  const raw = (config as { redactionRules?: unknown }).redactionRules
  const rules = Array.isArray(raw) ? (raw as RedactionRule[]) : []

  // "A newer version exists" is deliberately NOT applied on its own. Detector fixes
  // usually widen what gets deleted, and redaction deletes rather than masks, so
  // upgrading a project without asking would quietly destroy more of its text. The
  // owner is told and decides. A NARROWING fix - one that stops destroying text we
  // now know was legitimate - is the case where waiting is the harm, and that ships
  // as an explicit recompile named in the release notes rather than as a default.
  const outdatedDetectorIds = rules
    .filter((r): r is Extract<RedactionRule, { kind: "detector" }> => r?.kind === "detector")
    .filter((r) => {
      const newest = newestVersion(r.id)
      return newest !== null && newest > r.v
    })
    .map((r) => r.id)

  return {
    rules,
    unresolved,
    outdatedDetectorIds,
    catalogueEmpty: Object.keys(DETECTOR_CATALOGUE).length === 0,
  }
}
