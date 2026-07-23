import { z } from "zod"
import type { ErrorTranslator } from "@/lib/action-i18n"

/**
 * Built from the `errors` translator - see the note in modules/thread/schema.ts
 * for why a schema carrying user-facing copy is a factory rather than a
 * constant. Server callers pass `await getErrorTranslations()`; the new-project
 * form passes `useTranslations("errors")`.
 */
export function createProjectSchema(t: ErrorTranslator) {
  return z.object({
    name: z.string().min(1, t("project.nameRequired")).max(100),
    slug: z
      .string()
      .min(1, t("project.slugRequired"))
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, t("project.slugInvalidChars")),
    summary: z.string().max(200).optional(),
    description: z.string().optional(),
    thumbnailColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    /** Storage key from /api/media/upload — relative path, e.g. upload/<userId>/thumbnail-<hash>.webp */
    thumbnailUrl: z.string().optional().nullable(),
    /** Storage key from /api/media/upload for the background image */
    backgroundUrl: z.string().optional().nullable(),
  })
}

export type CreateProjectInput = z.infer<ReturnType<typeof createProjectSchema>>

export const updateProjectSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  summary: z.string().max(200).optional(),
  description: z.string().optional(),
  thumbnailColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  /** Storage key from /api/media/upload */
  thumbnailUrl: z.string().optional().nullable(),
  /** Storage key from /api/media/upload */
  backgroundUrl: z.string().optional().nullable(),
  conductor: z.record(z.string(), z.unknown()).optional(),
})

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>

export const updateRelayroomMdSchema = z.object({
  projectId: z.string().uuid(),
  // Empty string resets to the default template (stored as null).
  content: z.string().max(20000),
})

export type UpdateRelayroomMdInput = z.infer<typeof updateRelayroomMdSchema>

// ── Members (project_access) ────────────────────────────────────────────────

export const projectAccessLevel = z.enum(["readonly", "write", "owner"])
export type ProjectAccessLevelInput = z.infer<typeof projectAccessLevel>

export const addProjectMemberSchema = z.object({
  projectId: z.string().uuid(),
  userId: z.string().min(1),
  level: projectAccessLevel.default("write"),
})
export type AddProjectMemberInput = z.infer<typeof addProjectMemberSchema>

export const updateProjectMemberSchema = z.object({
  projectId: z.string().uuid(),
  userId: z.string().min(1),
  level: projectAccessLevel,
})
export type UpdateProjectMemberInput = z.infer<typeof updateProjectMemberSchema>

export const removeProjectMemberSchema = z.object({
  projectId: z.string().uuid(),
  userId: z.string().min(1),
})
export type RemoveProjectMemberInput = z.infer<typeof removeProjectMemberSchema>

// ── Governance ban / unban (phase 09) ────────────────────────────────────────

/** project = this project only; org = every project in the organization. */
export const banScope = z.enum(["project", "org"])
export type BanScopeInput = z.infer<typeof banScope>

export const banProjectMemberSchema = z.object({
  projectId: z.string().uuid(),
  userId: z.string().min(1),
  scope: banScope.default("project"),
})
export type BanProjectMemberInput = z.infer<typeof banProjectMemberSchema>

export const unbanProjectMemberSchema = banProjectMemberSchema
export type UnbanProjectMemberInput = z.infer<typeof unbanProjectMemberSchema>
