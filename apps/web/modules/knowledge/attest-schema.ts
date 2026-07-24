import { z } from "zod"
import type { ErrorTranslator } from "@/lib/action-i18n"

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
