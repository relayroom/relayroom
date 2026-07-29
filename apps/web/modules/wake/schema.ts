import { z } from "zod"

// NOTE: not a "use server" file. zod schemas are imported by actions, forms and
// queries. Keeping them here (per AGENTS.md) avoids breaking the client zodResolver.

// Owner edits their OWN budget. The ceiling matches the UI slider max (guards
// runaway input). Defaults/dogfooding rationale: spec §15.1 (wakesPerHour 30,
// urgentPerHour 5).
// The two fields do NOT mean the same thing at 0, so do not treat them alike:
// wakesPerHour 0 is only the lowest setting - the server still applies a
// per-project floor, so wakes keep arriving and the total scales with the number
// of projects the owner is in. urgentPerHour 0 is the absolute one.
export const upsertOwnerWakeBudgetSchema = z.object({
  wakesPerHour: z.number().int().min(0).max(240), // 0 = lowest, floor still applies
  urgentPerHour: z.number().int().min(0).max(60), // 0 = "nobody can wake me as urgent" (spec §7)
})
export type UpsertOwnerWakeBudgetInput = z.infer<typeof upsertOwnerWakeBudgetSchema>

// Project manager: max recipients per broadcast. null = runtime computed
// min(N, 8) (spec §15.1).
export const updateBroadcastCapSchema = z.object({
  projectId: z.string().uuid(),
  maxBroadcastRecipients: z.number().int().min(1).max(500).nullable(),
})
export type UpdateBroadcastCapInput = z.infer<typeof updateBroadcastCapSchema>

// Audit query window (hours). Default 24h.
export const wakeAuditWindowSchema = z.object({
  windowHours: z.number().int().min(1).max(720).default(24),
})
export type WakeAuditWindowInput = z.infer<typeof wakeAuditWindowSchema>
