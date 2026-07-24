import { z } from "zod"
import type { ErrorTranslator } from "@/lib/action-i18n"

/**
 * How a rotation treats the secret it replaces.
 *
 * - `hygiene`: the routine move. The replaced secret keeps verifying for a grace
 *   window so pipelines still carrying it do not break mid-run.
 * - `revoke`: the incident move. The replaced secret dies in the same write, with
 *   no grace, because a leaked secret's grace is exposure time.
 *
 * Lives here rather than in the actions module because that file is `"use server"`
 * and may only export async functions.
 */
export const ROTATION_MODES = ["hygiene", "revoke"] as const
export type RotationMode = (typeof ROTATION_MODES)[number]

export function isRotationMode(v: unknown): v is RotationMode {
  return typeof v === "string" && (ROTATION_MODES as readonly string[]).includes(v)
}

/**
 * Built from the `errors` translator - see the note in modules/thread/schema.ts
 * for why a schema carrying user-facing copy is a factory rather than a constant.
 */
export function addCheckMappingSchema(t: ErrorTranslator) {
  return z.object({
    projectId: z.string().uuid(t("knowledge.invalidTarget")),
    knowledgeId: z.string().uuid(t("knowledge.invalidTarget")),
    // A CI check name, e.g. "migration-smoke". Free text because the CI author
    // owns it; bounded so it cannot be a giant blob.
    checkName: z.string().trim().min(1, t("attest.checkNameRequired")).max(200),
  })
}

export type AddCheckMappingInput = z.infer<ReturnType<typeof addCheckMappingSchema>>
