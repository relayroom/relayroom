import { z } from "zod"

// Two consent modes only. `community` = anonymous aggregate telemetry is sent;
// `off` = nothing is transmitted. Kept here (NOT in the "use server" actions file)
// so the client form can import the schema for zodResolver without pulling a
// server module into the bundle.
export const TELEMETRY_MODES = ["community", "off"] as const

export const setTelemetryModeSchema = z.object({
  mode: z.enum(TELEMETRY_MODES),
})

export type TelemetryMode = (typeof TELEMETRY_MODES)[number]
export type SetTelemetryModeInput = z.infer<typeof setTelemetryModeSchema>

// Dashboard feedback form. `message` is required; `rating` (1-5) and `contact`
// are optional. Kept here (not in the "use server" actions file) so the client
// form can import it for validation without bundling a server module.
export const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  message: z.string().trim().min(1).max(2000),
  contact: z.string().trim().max(200).optional(),
})

export type FeedbackInput = z.infer<typeof feedbackSchema>
