import { and, eq, gte, inArray } from 'drizzle-orm'
import type { Db, DbOrTx } from '@relayroom/db'
import { ownerWakeBudgets, projectAccess, wakeEvents, wakeIntents } from '@relayroom/db'

// 롤링 윈도우 폭. 슬라이딩(고정 경계 아님). 스펙 §5.
export const WINDOW_MS = 60 * 60 * 1000

// 예산 기본값(스펙 §15.1). owner_wake_budget 행이 없을 때의 폴백.
export const DEFAULT_WAKES_PER_HOUR = 30
export const DEFAULT_URGENT_PER_HOUR = 5

// 프로젝트 예약 floor(스펙 §15.1): max(소유자 예산의 20%, 5/hr). priority는 2배 지분.
export const FLOOR_FRACTION = 0.2
export const FLOOR_MIN = 5
export const PRIORITY_MULTIPLIER = 2

// in-flight로 간주하는 비종료 상태(예약이 윈도우를 점유).
const IN_FLIGHT_STATES = ['pending', 'delivered', 'activated'] as const

export type ReserveReason =
  | 'ok' // 캡 아래, 허용
  | 'ok_floor' // 캡 도달했으나 이 프로젝트가 floor 미만이라 보장분으로 허용
  | 'cap' // 일반 wakesPerHour 캡 초과
  | 'urgent_cap' // urgentPerHour(U) 초과
  | 'urgent_zero' // U=0, urgent 영구 차단
  | 'no_owner' // ownerUserId null(소유자 없음 - 예산 적용 불가, 안전하게 거부)

export type ReserveResult = { allowed: boolean; reason: ReserveReason }

// 소유자의 예산 행 조회(없으면 기본값 폴백).
async function loadBudget(
  dbx: DbOrTx,
  ownerUserId: string,
): Promise<{ wakesPerHour: number; urgentPerHour: number }> {
  const [row] = await dbx.select().from(ownerWakeBudgets).where(eq(ownerWakeBudgets.userId, ownerUserId))
  if (!row) return { wakesPerHour: DEFAULT_WAKES_PER_HOUR, urgentPerHour: DEFAULT_URGENT_PER_HOUR }
  return { wakesPerHour: row.wakesPerHour, urgentPerHour: row.urgentPerHour }
}

// 롤링 60분 통제 카운트. urgent 카운트와 일반 카운트를 분리 집계.
// projectId가 주어지면 그 프로젝트분 카운트도 함께 반환(floor 판정용).
export type WindowCounts = { total: number; urgent: number; project: number }

export async function countWindow(
  dbx: DbOrTx,
  ownerUserId: string,
  projectId: string | null,
  now: Date = new Date(),
): Promise<WindowCounts> {
  const since = new Date(now.getTime() - WINDOW_MS)

  // (1) in-flight 예약: 비종료 wakeIntents, reservedAt >= since.
  const intents = await dbx
    .select({ id: wakeIntents.id, urgent: wakeIntents.urgent, projectId: wakeIntents.projectId })
    .from(wakeIntents)
    .where(
      and(
        eq(wakeIntents.ownerUserId, ownerUserId),
        inArray(wakeIntents.state, IN_FLIGHT_STATES as unknown as string[]),
        gte(wakeIntents.reservedAt, since),
      ),
    )

  // (2) 정산됨: wakeEvents, suppressed=false, createdAt >= since. EXCLUDE events whose
  // intent is still in-flight - that wake is already counted in (1). Each issued wake
  // writes both a pending intent AND a ledger event in the same tx, so without this
  // filter a fresh wake counts TWICE against the budget (it does not stop wakes - it
  // just suppresses ~2x early). A settled/expired intent is no longer in (1), so its
  // event correctly counts here.
  const inFlightIntentIds = new Set(intents.map(r => r.id))
  const settledRaw = await dbx
    .select({ wakeIntentId: wakeEvents.wakeIntentId, urgent: wakeEvents.urgent, projectId: wakeEvents.projectId })
    .from(wakeEvents)
    .where(
      and(
        eq(wakeEvents.ownerUserId, ownerUserId),
        eq(wakeEvents.suppressed, false),
        gte(wakeEvents.createdAt, since),
      ),
    )
  const settled = settledRaw.filter(e => e.wakeIntentId === null || !inFlightIntentIds.has(e.wakeIntentId))

  const rows = [...intents, ...settled]
  let total = 0
  let urgent = 0
  let project = 0
  for (const r of rows) {
    total += 1
    if (r.urgent) urgent += 1
    if (projectId && r.projectId === projectId) project += 1
  }
  return { total, urgent, project }
}

export type ReserveInput = {
  ownerUserId: string | null
  projectId: string
  urgent?: boolean
  now?: Date
}

// 발행 게이트 결정. wake를 만들지 않는다 - 허용 여부만 판정.
// (실제 wakeIntent 생성/예약은 02 ensurePending이, 같은 tx에서 이 결정을 적용해 05가 배선.)
export async function reserve(dbx: DbOrTx, input: ReserveInput): Promise<ReserveResult> {
  const { ownerUserId, projectId, urgent = false } = input
  const now = input.now ?? new Date()
  if (!ownerUserId) return { allowed: false, reason: 'no_owner' }

  const budget = await loadBudget(dbx, ownerUserId)
  const counts = await countWindow(dbx, ownerUserId, projectId, now)

  if (urgent) {
    // urgent는 일반 N과 무관하게 U만으로 판정(스펙 §7: 조용히 확장 금지).
    if (budget.urgentPerHour <= 0) return { allowed: false, reason: 'urgent_zero' }
    if (counts.urgent >= budget.urgentPerHour) return { allowed: false, reason: 'urgent_cap' }
    return { allowed: true, reason: 'ok' }
  }

  // 일반 레인: 롤링 총 카운트 vs wakesPerHour.
  if (counts.total < budget.wakesPerHour) return { allowed: true, reason: 'ok' }

  // 캡 도달. floor 보장: 이 프로젝트가 자기 보장분 미만이면 그래도 허용.
  const floor = await projectFloor(dbx, ownerUserId, projectId, budget.wakesPerHour)
  if (counts.project < floor) return { allowed: true, reason: 'ok_floor' }

  return { allowed: false, reason: 'cap' }
}

// 프로젝트 예약 floor(스펙 §9, §15.1). priority면 2배.
export async function projectFloor(
  dbx: DbOrTx,
  ownerUserId: string,
  projectId: string,
  wakesPerHour: number,
): Promise<number> {
  const base = Math.max(Math.floor(wakesPerHour * FLOOR_FRACTION), FLOOR_MIN)
  const [acc] = await dbx
    .select({ wakePriority: projectAccess.wakePriority })
    .from(projectAccess)
    .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, ownerUserId)))
  const priority = acc?.wakePriority ?? false
  return priority ? base * PRIORITY_MULTIPLIER : base
}

// 활성화 정산. wakeEvents 원장 1행(suppressed=false) + intent state='done'.
// 멱등: 이미 done/settled면 no-op(스펙 §6: 활성화 에포크당 1회 정산, 중복 넛지 재과금 없음).
// 원자성: 같은 tx에서 intent 종료 + event 기록 → 윈도우 카운트가 끊김 없이 이어짐.
export async function settle(dbx: Db, wakeIntentId: string): Promise<void> {
  await dbx.transaction(async tx => {
    const [intent] = await tx
      .select()
      .from(wakeIntents)
      .where(eq(wakeIntents.id, wakeIntentId))
      .for('update')
    if (!intent) return
    if (intent.state === 'done' || intent.settledAt) return // 멱등

    const now = new Date()
    await tx
      .update(wakeIntents)
      .set({ state: 'done', settledAt: now })
      .where(eq(wakeIntents.id, wakeIntentId))

    await tx.insert(wakeEvents).values({
      ownerUserId: intent.ownerUserId,
      agentId: intent.agentId,
      projectId: intent.projectId,
      wakeIntentId: intent.id,
      urgent: intent.urgent,
      suppressed: false,
      phantom: false,
      createdAt: now,
    })
  })
}

export type SweepCandidate = {
  agentId: string
  projectId: string
  ownerUserId: string
  allowed: boolean
  reason: ReserveReason
}

// 예산이 풀렸을 때 회수할 idle part 후보를 찾는다.
// 후보 = (이 소유자 소유) AND (최근 윈도우에 suppressed 이벤트 보유 = 억제 흔적)
//        AND (현재 활성 wakeIntent 없음 = idle, 코얼레싱 불변 존중).
// 각 후보에 대해 reserve()를 재평가해 allowed/reason을 첨부한다.
// NOTE: 실제 wake 발행(ensurePending 호출)은 여기서 하지 않는다 - 05의 issuance가 소유.
//       "pending unread 존재" 판정도 05에서 메시지 레이어와 함께 배선(여기선 억제 흔적 기준).
export async function sweepEligible(
  dbx: Db,
  ownerUserId: string,
  now: Date = new Date(),
): Promise<SweepCandidate[]> {
  const since = new Date(now.getTime() - WINDOW_MS)

  // 억제 흔적이 있는 idle agent 후보. 활성 intent가 있으면 코얼레싱으로 제외.
  const rows = await dbx
    .select({ agentId: wakeEvents.agentId, projectId: wakeEvents.projectId })
    .from(wakeEvents)
    .where(
      and(
        eq(wakeEvents.ownerUserId, ownerUserId),
        eq(wakeEvents.suppressed, true),
        gte(wakeEvents.createdAt, since),
      ),
    )
    .groupBy(wakeEvents.agentId, wakeEvents.projectId)

  const out: SweepCandidate[] = []
  for (const r of rows) {
    if (!r.agentId || !r.projectId) continue
    // 코얼레싱: 활성 intent 있으면 skip.
    const active = await dbx
      .select({ id: wakeIntents.id })
      .from(wakeIntents)
      .where(
        and(
          eq(wakeIntents.agentId, r.agentId),
          inArray(wakeIntents.state, IN_FLIGHT_STATES as unknown as string[]),
        ),
      )
    if (active.length > 0) continue

    const decision = await reserve(dbx, { ownerUserId, projectId: r.projectId, urgent: false, now })
    out.push({
      agentId: r.agentId,
      projectId: r.projectId,
      ownerUserId,
      allowed: decision.allowed,
      reason: decision.reason,
    })
  }
  return out
}
