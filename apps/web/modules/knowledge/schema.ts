import { z } from "zod"
import type { ErrorTranslator } from "@/lib/action-i18n"

/**
 * Built from the `errors` translator - see the note in modules/thread/schema.ts
 * for why a schema carrying user-facing copy is a factory rather than a constant.
 */
export function promoteKnowledgeSchema(t: ErrorTranslator) {
  return z.object({
    projectId: z.string().uuid(t("knowledge.invalidTarget")),
    knowledgeId: z.string().uuid(t("knowledge.invalidTarget")),
  })
}

export type PromoteKnowledgeInput = z.infer<ReturnType<typeof promoteKnowledgeSchema>>
