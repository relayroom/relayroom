/**
 * Regression: zod validation messages must come out of the `errors` namespace,
 * not as hardcoded Korean and not as a raw translation key.
 *
 * These schemas are factories taking the translator precisely because a zod
 * message is rendered verbatim - a toast from a Server Action, or
 * react-hook-form printing errors.<field>.message straight into a form. Two
 * ways that silently regresses, both caught here:
 *
 *   - a message left as a Korean literal reaches an en reader untranslated;
 *   - a mistyped key still "works", because next-intl returns the key itself
 *     when it cannot resolve one, so the user reads "thread.subjectRequird".
 *
 * Goes through the real Server Action so it covers the schema, the key, and the
 * action's use of parsed.error.issues[0].message together. Test runs have no
 * request scope, so getErrorTranslations serves the default-locale (en) copy.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>()
  return { ...actual, getServerSession: vi.fn(async () => ({ user: { id: "validation-i18n-user" } })) }
})
vi.mock("@/lib/active-org", () => ({
  resolveActiveOrgId: vi.fn(async () => "org-validation-i18n"),
}))

import { db } from "@/lib/db"
import { getErrorTranslations } from "@/lib/action-i18n"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
} from "@relayroom/db/auth-schema"
import { createThreadSchema, postMessageSchema } from "./schema"
import { connectAgentSchema } from "@/modules/agent/schema"
import { createProjectSchema } from "@/modules/project/schema"

const ORG = "org-validation-i18n"
const USER = "validation-i18n-user"

// createThread authorizes before it parses, so the caller has to be a real org
// member for the request to reach validation at all.
beforeAll(async () => {
  await db
    .insert(better_auth_organization)
    .values({ id: ORG, name: "Validation i18n Org", createdAt: new Date() })
    .onConflictDoNothing()
  await db
    .insert(better_auth_user)
    .values({ id: USER, name: USER, email: `${USER}@test.local`, emailVerified: true })
    .onConflictDoNothing()
  await db
    .insert(better_auth_member)
    .values({ id: `m-${USER}`, organizationId: ORG, userId: USER, role: "member", createdAt: new Date() })
    .onConflictDoNothing()
})

afterAll(async () => {
  await db.$client.end()
})

/** Every key the three schema factories can emit. */
const KEYS = [
  "thread.subjectRequired",
  "thread.bodyRequired",
  "thread.recipientRequired",
  "agent.connectCodeRequired",
  "agent.partRequired",
  "agent.partTooLong",
  "agent.partInvalidChars",
  "project.nameRequired",
  "project.slugRequired",
  "project.slugInvalidChars",
]

describe("schema validation messages", () => {
  it("resolves every key to real en copy, not the key and not Korean", async () => {
    const t = await getErrorTranslations()
    for (const key of KEYS) {
      const copy = t(key)
      expect(copy, key).not.toBe(key)
      expect(copy, key).not.toContain(key)
      expect(/[가-힣]/.test(copy), `${key} should be English under the en locale`).toBe(false)
    }
  })

  it("surfaces the translated message for each failing field", async () => {
    const t = await getErrorTranslations()

    const thread = createThreadSchema(t).safeParse({
      projectId: "00000000-0000-0000-0000-000000000000",
      subject: "",
      body: "",
      targetAgentIds: [],
    })
    expect(thread.success).toBe(false)
    if (!thread.success) {
      const messages = thread.error.issues.map((i) => i.message)
      expect(messages).toContain(t("thread.subjectRequired"))
      expect(messages).toContain(t("thread.bodyRequired"))
      expect(messages).toContain(t("thread.recipientRequired"))
    }

    const message = postMessageSchema(t).safeParse({
      threadId: "00000000-0000-0000-0000-000000000000",
      body: "",
    })
    expect(message.success).toBe(false)
    if (!message.success) {
      expect(message.error.issues[0]!.message).toBe(t("thread.bodyRequired"))
    }

    const agent = connectAgentSchema(t).safeParse({ connectCode: "", part: "Not A Slug" })
    expect(agent.success).toBe(false)
    if (!agent.success) {
      const messages = agent.error.issues.map((i) => i.message)
      expect(messages).toContain(t("agent.connectCodeRequired"))
      expect(messages).toContain(t("agent.partInvalidChars"))
    }

    const project = createProjectSchema(t).safeParse({ name: "", slug: "Not A Slug" })
    expect(project.success).toBe(false)
    if (!project.success) {
      const messages = project.error.issues.map((i) => i.message)
      expect(messages).toContain(t("project.nameRequired"))
      expect(messages).toContain(t("project.slugInvalidChars"))
    }
  })

  it("carries the message all the way out of a Server Action", async () => {
    const t = await getErrorTranslations()
    const { createThread } = await import("./actions")
    const res = await createThread({
      projectId: "00000000-0000-0000-0000-000000000000",
      subject: "",
      body: "hello",
      targetAgentIds: ["00000000-0000-0000-0000-000000000000"],
    })
    expect(res.result).toBe(false)
    if (!res.result) {
      expect(res.message).toBe(t("thread.subjectRequired"))
      expect(/[가-힣]/.test(res.message ?? "")).toBe(false)
    }
  })
})
