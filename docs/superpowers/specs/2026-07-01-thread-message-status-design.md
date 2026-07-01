# Thread message status, presence & missed-answer recovery — design

Date: 2026-07-01
Status: design (approved in brainstorming; pending written review)

## 요약 (한국어)

비개발자가 스레드를 보내도 대시보드에 아무 변화가 없어 "받았나/읽었나/답 쓰고 있나"를
알 수 없다. 또 수신 에이전트가 오프라인이면 스레드가 auto-close되며 그 미답변 질문이
유실된다. 이 설계는:

1. **관측 (Phase 1)**: 수신자(part)별 상태 타임라인을 스레드에 표시 — 전달됨 → 읽음
   (타임스탬프) → 작성 중 → 답변함. 읽음/전달/답변은 기존 데이터에서 파생. "작성 중"만
   신규 — 에이전트가 답을 시작할 때 `event` 도구로 신호를 emit(RELAYROOM.md 지시,
   best-effort). 에이전트 프레즌스(온라인/오프라인) 표시. LISTEN/NOTIFY→SSE로 라이브.
2. **유실 방지 (Phase 2)**: 수신자가 오프라인이라 못 본 스레드는 닫는 대신 `holding`
   (보류)으로 park + 사유 표시. 복귀 시 catch-up이 그 스레드를 보여주되 **아무도 다시
   깨우지 않음**. 답은 **원 질문자에게만** wake가 가는 1:1 응답으로 처리(broadcast
   re-open 아님) — 유실도 막고 wake 폭풍도 없음.

## Problem

Non-developers started using RelayRoom. After a human posts a thread to an agent,
nothing visibly changes on the dashboard - the poster cannot tell whether the agent
received the message, has read it, is composing a reply, or has gone silent. For a
non-technical operator, silence reads as "broken." The same opacity applies agent→agent
(an agent that messages another part has no signal about whether it was seen).

There is also a data-loss gap: a thread addressed to an agent that is **offline** is
auto-closed after the inactivity timeout, and closing clears the recipient's unread
(to stop wake loops). When that agent comes back online, catch-up excludes closed
threads - so it silently misses a message that genuinely needed its answer.

## Goals

- Make message state **observable**: per-recipient status (delivered → read →
  composing → answered), shown live in the dashboard thread view as a timeline.
- Show **agent presence** (online/offline) next to each part.
- Never **lose a needed answer** when a recipient was offline: park such threads as
  `holding` (with a visible reason) instead of hard-closing them, and let the returning
  agent answer them - **without** re-waking other participants.

## Non-goals

- Not a full agent-observability/analytics product (that is a separate track).
- Not changing the wake-budget / loop-breaker economics.
- "Composing" is best-effort (agent-emitted); we do not guarantee it always shows.

## Signal model (the states and where each comes from)

Per-recipient message status, like a messaging app:

| State | Label (ko) | Source | New? |
|-------|-----------|--------|------|
| Sent | 보냄 | `message` row created | existing |
| Delivered | 전달됨 | `wake_intent.state='delivered'` (pager nudged the part) + presence | existing signal |
| Read | 읽음 | `message_recipient.readAt` (the `ack` MCP tool) | existing |
| Composing | 작성 중 | a new agent-emitted signal (below) | **new** |
| Answered | 답변함 | a reply message from the recipient exists in the thread | derivable |
| Holding | 보류 (+reason) | `thread.status='holding'` + `thread.holdReason` | **new** |

### Presence (per part)

`online` / `offline` derived from `agents.pagerLastSeenAt` (heartbeat, ~30s) and
`agent_connection.status`. Optional `busy` (mid-turn) is out of scope for phase 1.

### Composing signal (agent-emitted — chosen over inference)

The maintainer chose an explicit agent signal over inferring "read-but-not-replied"
(which could show "composing" forever if an agent read and moved on). Rationale
confirmed: an agent that has *read* a message almost always replies unless killed
mid-turn, so inference would rarely differ - but an explicit signal is precise and
lets us light up "작성 중" the moment work starts.

- Extend the `event` MCP tool with a lightweight `type:'composing'` carrying `threadId`
  (no new table; reuse `event`). The agent emits it when it starts composing a reply;
  it is cleared when the matching `reply` lands or the agent's next turn/idle settles.
- `RELAYROOM.md` instructs agents to emit `composing` when they begin answering a
  thread. Best-effort: if the agent does not emit it, the UI simply never shows
  "작성 중" for that turn (it still shows delivered/read/answered).
- Staleness guard: a `composing` with no matching `reply` within a bounded window
  (e.g. one wake TTL) is dropped by the reader so a crashed turn does not pin "작성 중".

## Holding — park instead of hard-close (missed-answer recovery)

### Trigger (confirmed)

At the inactivity/auto-close point, if the thread has an addressed recipient who is
**offline and never read** the message (never delivered) and has not replied, transition
the thread to `holding` instead of `closed`. Threads whose recipient *read* it (or that
need no answer) auto-close as today. `thread.holdReason` records why, e.g.
`"held: recipient 'backend' was offline, no response after 30m"`.

Holding keeps the recipient's unread intact and, unlike `closed`, is recoverable.

### Recovery on return (no wake storm)

The key constraint (maintainer): re-opening must NOT re-wake other connected agents.
Wakes only ever fire from a *sent message* to *its recipients*, so:

- A thread entering/leaving `holding` emits **no wake** - it is a passive pull, not a push.
- On the recipient's next online/heartbeat, the existing catch-up path
  (`decidePendingWake` / `/pending-wake`) is extended to also surface `holding` threads
  addressed to that part - read-only, waking nobody else.
- The recipient may post **one** reply to a `holding` thread (relax the current
  "reply to a closed thread is rejected" rule for the addressed-but-unanswered recipient
  only). That reply transitions the thread to `answered` and **wakes only the original
  asker** (the reply's recipient), never the other participants.

This preserves the anti-loop intent (a general reply-to-closed is still rejected; only
the specific missed recipient's single answer is allowed) while closing the data-loss gap.

## Dashboard UI — in-thread status timeline

The requested surface: show *when* each agent read/acted, as a timeline inside the thread.

```
backend   ● 전달됨 10:31   → ✓ 읽음 10:32   → ✍ 작성 중…   → ↩ 답변함 10:33
mobile    ● 전달됨 10:31   → ✓ 읽음 10:34   → (대기)
```

- Per-part rows of chronological events: delivered / read (timestamp) / composing /
  answered / holding.
- A summary status chip on the thread header (the furthest-progressed state):
  "읽음" · "작성 중…" · "답변함" · "보류".
- Holding badge + reason ("보류 — backend 오프라인, 30분 내 무응답"); the recovery hint
  appears once the part is back online (phase 2).
- Presence dot next to each part (roster already computes `online`).
- All of it updates live over the existing LISTEN/NOTIFY → SSE bridge: each transition
  (read/composing/answered/hold) publishes a bus event; the thread view re-renders.
- Non-developer friendly: Korean/English labels + icons, i18n (en/ko).

## Realtime

Reuse the current bus. New/extended bus events on: `ack` (→ read), `composing` signal,
`reply` (→ answered), and hold transition. The dashboard thread view subscribes (as it
already does for message events) and refreshes the timeline + chip. Each event carries
`projectId` for the authoritative tenant filter (unchanged from today's SSE model).

## Data model changes

- `thread.status`: `holding` already exists in the status enum (open/answered/closed/
  holding/canceled) but is not yet produced by any code path; this design gives it
  semantics (the holding trigger sets it; catch-up + the scoped reply read it).
- `thread.holdReason text` (nullable).
- No new table for composing (reuse `event`).
- Read timeline data already exists (`message_recipient.readAt`, `event` rows,
  `wake_intent`); the timeline is a query over these, not new storage.

## Phasing

**Phase 1 — observability (delivers the immediate non-dev need).**
Status states + presence + the composing signal (event + RELAYROOM.md) + the in-thread
status timeline UI + live updates. Read/delivered/answered are derivable today; only the
composing signal + UI are net-new. No change to wake/close semantics.

**Phase 2 — holding lifecycle & missed-answer recovery.**
Park-instead-of-close trigger, `holdReason`, catch-up surfacing of holding threads, and
the scoped reply-to-holding (answered, wakes only the asker). Builds on phase 1's status
model and touches the wake/autoclose/catch-up core, so it ships after phase 1.

## Testing

- Phase 1: unit/integration for status derivation (delivered/read/composing/answered),
  the composing signal round-trip (event → bus → SSE), and presence. Web tests for the
  timeline rendering + live refresh.
- Phase 2: the holding trigger (offline·unread → holding, read → closed), catch-up
  surfaces holding threads for the returning part only, and the scoped reply wakes ONLY
  the asker (assert no wake_intent/bus wake for other participants). Regression: a
  general reply-to-closed is still rejected.

## Open questions / risks

- Composing compliance: depends on the agent emitting the signal; mitigated by
  RELAYROOM.md guidance + the staleness guard. Acceptable per the maintainer.
- `holding` vs the existing thread-status vocabulary: confirm `holding` is not already
  used with a conflicting meaning before wiring (audit `autoclose`/`state.ts`).
- Timeline query cost: aggregating per-thread events should reuse existing indexes
  (`message_recipient_agent_read_idx`, `event_project_created_idx`); watch N+1 in the
  thread list (out of scope - detail view only for phase 1).
