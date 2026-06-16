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
