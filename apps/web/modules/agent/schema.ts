import { z } from "zod"

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

export const connectAgentSchema = z.object({
  connectCode: z.string().min(1, "연결 코드가 필요합니다."),
  machineLabel: z.string().max(200).optional(),
  // part is an identifier baked into tmux/URL/CLI commands, so it must be a slug.
  part: z
    .string()
    .min(1, "파트 이름을 입력하세요.")
    .max(32, "파트 이름이 너무 깁니다. (최대 32자)")
    .regex(/^[a-z0-9_-]+$/, "영문 소문자, 숫자, -, _ 만 사용할 수 있어요."),
  nickname: z.string().max(100).optional(),
  color: z.string().max(20).optional(),
  icon: z.string().max(20).optional(),
})

export type ConnectAgentInput = z.infer<typeof connectAgentSchema>
