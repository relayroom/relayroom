import { z } from "zod"
import type { ErrorTranslator } from "@/lib/action-i18n"

export const updateAgentSchema = z.object({
  agentId: z.string().uuid(),
  nickname: z.string().max(100).optional(),
  badge: z.string().max(200).optional(),
})

export type UpdateAgentInput = z.infer<typeof updateAgentSchema>

/** Live (per-keystroke) slug: lowercase, invalid runs -> "-", collapse repeats,
 *  capped at 32. Does NOT trim leading/trailing -/_ so the user can actually TYPE
 *  them mid-word (trimming every keystroke would eat a "-" or "_" the instant it's
 *  the last char). Final trim happens in toPartSlug on blur/submit. */
export function toPartSlugLive(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 32)
}

/** Full slug for blur/submit: live cleanup plus trimmed leading/trailing -/_
 *  (matches server isValidPart). */
export function toPartSlug(input: string): string {
  return toPartSlugLive(input).replace(/^[-_]+|[-_]+$/g, "")
}

/**
 * Built from the `errors` translator - see the note in modules/thread/schema.ts
 * for why a schema carrying user-facing copy is a factory rather than a
 * constant. Server callers pass `await getErrorTranslations()`; the connect
 * dialog passes `useTranslations("errors")`.
 */
export function connectAgentSchema(t: ErrorTranslator) {
  return z.object({
    connectCode: z.string().min(1, t("agent.connectCodeRequired")),
    machineLabel: z.string().max(200).optional(),
    // part is an identifier baked into tmux/URL/CLI commands, so it must be a slug.
    part: z
      .string()
      .min(1, t("agent.partRequired"))
      .max(32, t("agent.partTooLong"))
      .regex(/^[a-z0-9_-]+$/, t("agent.partInvalidChars")),
    nickname: z.string().max(100).optional(),
    color: z.string().max(20).optional(),
    icon: z.string().max(20).optional(),
  })
}

export type ConnectAgentInput = z.infer<ReturnType<typeof connectAgentSchema>>
