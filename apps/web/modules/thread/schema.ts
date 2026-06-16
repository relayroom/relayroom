import { z } from "zod"

export const postMessageSchema = z.object({
  threadId: z.string().uuid(),
  body: z.string().min(1, "내용을 입력하세요.").max(50000),
  targetAgentIds: z.array(z.string().uuid()).optional(),
})

export type PostMessageInput = z.infer<typeof postMessageSchema>

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
