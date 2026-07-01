# Live Read Receipts Implementation Plan (P1-a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent reads a message, the dashboard thread view shows the read
receipt live (no manual refresh) and shows *when* it was read.

**Architecture:** The read receipt UI and the `readAt` data already exist
(`getThread` returns `readReceipts[].readAt`; the thread page renders "read by X").
The gap is liveness: the `ack` MCP tool sets `readAt` but emits no bus event, so the
dashboard never refreshes. Add a new `read` bus-event kind (a dedicated kind is
required — reusing `message` would make pagers treat it as a wake) that `ack` emits;
the existing realtime-provider already refreshes the route on any non-pager event.
Then surface the `readAt` timestamp in the read-receipt line.

**Tech Stack:** TypeScript, Hono + MCP (server), Next.js App Router + next-intl (web),
Postgres LISTEN/NOTIFY → SSE bus, vitest.

## Global Constraints

- pnpm only; install latest stable of any new dep (none expected here).
- No em dashes in code/copy/comments — use a hyphen `-`.
- User-facing strings are `t("...")` (next-intl); keep `messages/en` and `messages/ko`
  key sets in sync (i18n parity).
- Before committing: `pnpm --filter <pkg> test`, and for touched TS, it must typecheck.
- `apps/server/src/routes/mcp.ts` is a hot path (agent bus). After implementing, the
  change gets a Codex review (codex-rescue) before the PR.
- Public CE: land via branch -> PR -> CI, never a direct push to main. Work continues
  on branch `feat/thread-message-status`.
- Bus events MUST carry `projectId` (authoritative tenant filter for SSE).

---

### Task 1: Add the `read` bus-event kind (shared)

**Files:**
- Modify: `packages/shared/src/index.ts` (the `HubBusEvent` union, ~line 108-137)
- Test: `packages/shared/test/` (type-only change; no runtime test — verified by tsc + downstream tasks)

**Interfaces:**
- Produces: `HubReadEvent` = `{ kind: 'read'; projectId: string; project: string; part: string; messageId: string }` and `HubBusEvent` now includes it.

- [ ] **Step 1: Add the type**

In `packages/shared/src/index.ts`, after `HubPagerEvent` and before the
`HubBusEvent` union, add:

```ts
/** An agent marked a message read (ack) - drives live read-receipt refresh on the
 *  dashboard. A dedicated kind (not `message`) so pagers do NOT treat it as a wake. */
export type HubReadEvent = {
  kind: 'read'
  /** Authoritative project id (used for tenant-safe SSE filtering). */
  projectId: string
  /** Project slug (display only; not unique across orgs). */
  project: string
  /** The part that read the message (the reader). */
  part: string
  /** The message that was read. */
  messageId: string
}
```

Then change the union:

```ts
export type HubBusEvent = HubMessageEvent | HubPagerEvent | HubReadEvent
```

- [ ] **Step 2: Typecheck + build shared**

Run: `pnpm --filter @relayroom/shared build`
Expected: builds clean (no type errors).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): add 'read' bus-event kind for live read receipts"
```

---

### Task 2: Emit a `read` bus event from the `ack` tool (server)

**Files:**
- Modify: `apps/server/src/routes/mcp.ts` (the `ack` tool, ~line 693-735; it already has `bus` and `ctx` in scope, like `send`/`reply`)
- Test: `apps/server/test/mcp.test.ts`

**Interfaces:**
- Consumes: `HubReadEvent` from Task 1; `bus.emit('message', payload)` (the bus event name is always `'message'`; `payload.kind` distinguishes).
- Produces: on a real (newly-read) ack, a bus event `{ kind:'read', projectId, project, part, messageId }`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/mcp.test.ts` inside the main describe block (uses the existing
`setupCaller`, `callTool`, and `app`/`bus` from `helpers`):

```ts
it('ack emits a read bus event (live read receipts) on a first read', async () => {
  const { projectId, connectCode, rawToken } = await setupCaller()
  await ensureAgents(projectId, 'reader', 'sender')
  // Create a thread + message addressed to 'reader' via the send tool.
  const sent = await callTool(connectCode, rawToken, 'sender', 'send', {
    subject: 'ping', body: 'hi', to: ['reader'],
  })
  const { threadId } = JSON.parse(sent.text) as { threadId: string; messageId: string }
  // Find reader's message id from the thread.
  const shown = await callTool(connectCode, rawToken, 'reader', 'inbox', {})
  const inbox = JSON.parse(shown.text) as Array<{ messageId: string; threadId: string }>
  const item = inbox.find((m) => m.threadId === threadId)!

  // Subscribe, then ack, and assert a 'read' event for the reader arrives.
  const events: Array<{ kind: string; part?: string; messageId?: string }> = []
  const listener = (e: { kind: string; part?: string; messageId?: string }) => events.push(e)
  bus.on('message', listener)
  await callTool(connectCode, rawToken, 'reader', 'ack', { messageId: item.messageId })
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('no read event')), 3000)
    const poll = setInterval(() => {
      if (events.some((e) => e.kind === 'read' && e.part === 'reader' && e.messageId === item.messageId)) {
        clearInterval(poll); clearTimeout(deadline); resolve()
      }
    }, 10)
  })
  bus.off('message', listener)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @relayroom/server test mcp -t "ack emits a read bus event"`
Expected: FAIL (no `read` event is emitted yet).

- [ ] **Step 3: Emit the event in the ack tool**

In `apps/server/src/routes/mcp.ts`, inside the `ack` tool's `if (updated) { ... }`
block (after the `settleCaughtUp` line, before the `return`), add:

```ts
        // Live read receipt: tell the dashboard this message was read so the thread
        // view refreshes without a manual reload. A 'read' kind (not 'message') so
        // pagers ignore it (they only wake on kind:'message').
        bus.emit('message', {
          kind: 'read',
          projectId: ctx.projectId,
          project: ctx.projectSlug,
          part: ctx.part,
          messageId: args.messageId,
        })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @relayroom/server test mcp -t "ack emits a read bus event"`
Expected: PASS.

- [ ] **Step 5: Run the full server suite (no regression)**

Run: `pnpm --filter @relayroom/server test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/mcp.ts apps/server/test/mcp.test.ts
git commit -m "feat(server): ack emits a 'read' bus event so read receipts go live"
```

---

### Task 3: Show the read timestamp in the thread view (web)

**Files:**
- Modify: `apps/web/app/(dashboard)/projects/[slug]/threads/[id]/page.tsx` (the read-receipt block, ~line 176-188)
- Modify: `apps/web/messages/en/project.json` and `apps/web/messages/ko/project.json` (the `threadDetail.readBy` key -> a form that includes time)
- Test: `apps/web/modules/thread/queries.test.ts` (assert `readReceipts[].readAt` is returned — the data contract the UI depends on). UI rendering itself is verified manually (the web vitest env is `node`, no jsdom).

**Interfaces:**
- Consumes: `getThread(...).item.messages[].readReceipts[]` = `{ agentPart: string; agentNickname: string | null; readAt: Date; ... }` (already returned by `getThread`, thread/queries.ts).

- [ ] **Step 1: Write the failing (data-contract) test**

Confirm/extend `apps/web/modules/thread/queries.test.ts` so a read message's receipt
includes a `readAt`. Add (adapt the seeding to the file's existing helpers):

```ts
it("getThread read receipts include readAt (for the timeline timestamp)", async () => {
  // ... seed a project, a thread, a message, and a message_recipient with readAt set ...
  const res = await getThread(projectId, threadId)
  expect(res.result).toBe(true)
  const msg = res.item.messages[0]
  expect(msg.readReceipts.length).toBeGreaterThan(0)
  expect(msg.readReceipts[0].readAt).toBeInstanceOf(Date)
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @relayroom/web test thread`
Expected: PASS if `getThread` already returns `readAt` (it does per thread/queries.ts) —
this test locks the contract so a future refactor can't drop it. If it fails, `getThread`
is not returning `readAt` and must be fixed first.

- [ ] **Step 3: Update the i18n key to include time**

In `apps/web/messages/en/project.json`, change `threadDetail.readBy` from the
readers-only form to include time, and keep `ko` in sync. Example values:

en: `"readBy": "Read by {readers}"` -> `"readBy": "Read by {readers}"` (unchanged label)
and add: `"readAtLabel": "{part} read {time}"`

ko: add `"readAtLabel": "{part} 읽음 {time}"`

(Use whichever phrasing reads best; the key must exist in BOTH en and ko.)

- [ ] **Step 4: Render the timestamp**

In `page.tsx`, replace the read-receipt block (lines ~176-188) so each reader shows
its read time (data already present as `r.readAt`):

```tsx
{/* Read receipts (with time - a lightweight per-message read timeline) */}
{msg.readReceipts.length > 0 && (
  <div className="flex flex-col gap-0.5 pt-0.5">
    {msg.readReceipts.map((r) => (
      <div key={r.agentId} className="flex items-center gap-1.5">
        <CheckCheckIcon className="h-3 w-3 text-muted-foreground/60" />
        <span className="text-xs text-muted-foreground">
          {t("threadDetail.readAtLabel", {
            part: r.agentPart + (r.agentNickname ? ` (${r.agentNickname})` : ""),
            time: formatDateTime(r.readAt.toISOString()),
          })}
        </span>
      </div>
    ))}
  </div>
)}
```

(`formatDateTime` and `CheckCheckIcon` are already imported in this file.)

- [ ] **Step 5: Typecheck + run web tests + i18n parity**

Run: `pnpm --filter @relayroom/web test thread`
Expected: PASS.
Run: the i18n parity check (en vs ko keys) used elsewhere in the repo; expected: OK.

- [ ] **Step 6: Manual verification note**

Because the web vitest env is `node` (no jsdom), verify the live behavior by hand:
open a thread in the dashboard, have an agent `ack` a message, and confirm the read
line appears with a timestamp WITHOUT reloading (the `read` bus event drives the
realtime-provider refresh).

- [ ] **Step 7: Commit**

```bash
git add "apps/web/app/(dashboard)/projects/[slug]/threads/[id]/page.tsx" \
  apps/web/messages/en/project.json apps/web/messages/ko/project.json \
  apps/web/modules/thread/queries.test.ts
git commit -m "feat(web): show read timestamp in the thread read receipts"
```

---

## Self-Review

**Spec coverage (P1-a slice of the design):** live read status (delivered/read) — the
`read` event + existing read-receipt UI cover "read"; the timestamp covers "when read".
Composing / presence / holding are explicitly OUT of this plan (P1-b / P1-c / P2).

**Placeholder scan:** the i18n step leaves the exact copy to the implementer's taste but
names the exact keys and both locales; the query test seeding is delegated to the file's
existing helpers (the assertion is exact). No "TODO/handle edge cases" steps.

**Type consistency:** `HubReadEvent` fields (kind/projectId/project/part/messageId) are
produced in Task 2 exactly as defined in Task 1; the web consumes `readReceipts[].readAt`
/ `agentPart` / `agentNickname` / `agentId` as returned by `getThread`.

**Realtime path check:** `ack` runs on the Hono server; `bus.emit` -> NOTIFY -> the web
process's LISTEN -> `/api/realtime` (filtered by projectId) -> realtime-provider, which
already `router.refresh()`es on any non-pager event. No client code change needed; the
new kind falls through the existing `if (kind==='pager')` guard to the refresh path.

## Follow-on plans (not this plan)

- **P1-b Composing signal:** extend the `event` tool with `type:'composing'` (+ threadId)
  that emits a `composing` bus event; RELAYROOM.md guidance; live "작성 중" chip
  (transient, may skip the full refresh). Builds on this plan's bus-event pattern.
- **P1-c Presence in the thread view:** show each addressed part's online/offline dot
  (roster/realtime-provider already compute pager online).
- **P2 Holding lifecycle & missed-answer recovery:** park-instead-of-close + scoped reply.

## Execution Handoff

After saving, choose execution: Subagent-Driven (fresh subagent per task, review
between) or Inline (executing-plans with checkpoints). The server change (Task 2) also
takes a Codex hot-path review before the PR.
