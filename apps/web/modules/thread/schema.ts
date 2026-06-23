import { z } from "zod"

export const postMessageSchema = z.object({
  threadId: z.string().uuid(),
  body: z.string().min(1, "내용을 입력하세요.").max(50000),
  targetAgentIds: z.array(z.string().uuid()).optional(),
})

export type PostMessageInput = z.infer<typeof postMessageSchema>

export const createThreadSchema = z.object({
  projectId: z.string().uuid(),
  subject: z.string().min(1, "제목을 입력하세요.").max(200),
  body: z.string().min(1, "내용을 입력하세요.").max(50000),
  // The parts to address (and wake). The dashboard defaults this to the main agent.
  targetAgentIds: z.array(z.string().uuid()).min(1, "받는 에이전트를 선택하세요."),
})

export type CreateThreadInput = z.infer<typeof createThreadSchema>

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
