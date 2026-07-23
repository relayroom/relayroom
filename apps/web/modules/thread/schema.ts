import { z } from "zod"
import type { ErrorTranslator } from "@/lib/action-i18n"

/**
 * Schemas carrying user-facing messages are built by a factory that takes the
 * `errors` translator, rather than being module-level constants with literal
 * copy.
 *
 * A zod message is rendered verbatim wherever the failure surfaces - a toast
 * from a Server Action, or react-hook-form printing `errors.<field>.message`
 * straight into the form. So the message cannot be a translation key: whatever
 * the schema holds is what the user reads. Taking the translator makes the
 * dependency explicit and impossible to forget - there is no way to build the
 * schema without it - which the alternative (store a key, translate at each
 * display site) cannot promise, because a display site that forgets simply
 * shows the raw key.
 *
 * Server callers pass `await getErrorTranslations()`; client forms pass
 * `useTranslations("errors")`. The import here is type-only, so this module
 * stays free of the server-only code in lib/action-i18n.
 *
 * NOTE: lib/validation.ts solves the same problem the other way - it stores
 * keys and translates at the call site, with a fallback to
 * errors.common.invalidInput so a stray key can never reach the screen. That
 * fits there because those schemas are only ever parsed inside Server Actions.
 * These are also fed to zodResolver in client forms, where no server-side
 * translation step exists to fall back through.
 */
export function postMessageSchema(t: ErrorTranslator) {
  return z.object({
    threadId: z.string().uuid(),
    body: z.string().min(1, t("thread.bodyRequired")).max(50000),
    targetAgentIds: z.array(z.string().uuid()).optional(),
  })
}

export type PostMessageInput = z.infer<ReturnType<typeof postMessageSchema>>

export function createThreadSchema(t: ErrorTranslator) {
  return z.object({
    projectId: z.string().uuid(),
    subject: z.string().min(1, t("thread.subjectRequired")).max(200),
    body: z.string().min(1, t("thread.bodyRequired")).max(50000),
    // The parts to address (and wake). The dashboard defaults this to the main agent.
    targetAgentIds: z.array(z.string().uuid()).min(1, t("thread.recipientRequired")),
  })
}

export type CreateThreadInput = z.infer<ReturnType<typeof createThreadSchema>>

export const closeThreadSchema = z.object({
  threadId: z.string().uuid(),
  status: z.enum(["open", "closed", "canceled", "answered", "holding"]),
})

export type CloseThreadInput = z.infer<typeof closeThreadSchema>

export const addTagsSchema = z.object({
  threadId: z.string().uuid(),
  tags: z.array(z.string().min(1).max(50)).min(1),
})

export type AddTagsInput = z.infer<typeof addTagsSchema>

export const dismissAttentionSchema = z.object({
  threadId: z.string().uuid(),
})

export type DismissAttentionInput = z.infer<typeof dismissAttentionSchema>
