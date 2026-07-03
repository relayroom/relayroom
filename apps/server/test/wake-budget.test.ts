import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createDb, type Db } from '@relayroom/db'
import {
  agents,
  authSchema,
  ownerWakeBudgets,
  projectAccess,
  projects,
  wakeEvents,
  wakeIntents,
} from '@relayroom/db'
import { projectFloor, reserve, settle, sweepEligible, WINDOW_MS } from '../src/wake/budget'

const TEST_DATABASE_URL = 'postgres://hub:hub@localhost:48802/hub_test'
const db: Db = createDb(TEST_DATABASE_URL)

// 고정 owner/project/agent fixture. 각 테스트가 깨끗한 상태에서 시작하도록 truncate.
const OWNER = 'user_owner_03'
let projectId: string
let agentId: string

async function freshAgent(pid: string, owner: string, part: string): Promise<string> {
  const [a] = await db.insert(agents).values({ projectId: pid, part, ownerUserId: owner }).returning()
  return a.id
}

// owner_wake_budget / project_access / agent.owner_user_id 는 better_auth_user(id)에 FK 건다.
// 그래서 fixture owner principal 을 먼저 시드해야 한다(plan 의 verbatim fixture 에는 누락됨).
async function seedUser(id: string): Promise<void> {
  await db
    .insert(authSchema.better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

beforeEach(async () => {
  // 외래키 순서대로 정리.
  await db.delete(wakeEvents)
  await db.delete(wakeIntents)
  await db.delete(agents)
  await db.delete(projectAccess)
  await db.delete(ownerWakeBudgets)
  await db.delete(projects)
  await db.delete(authSchema.better_auth_user).where(eq(authSchema.better_auth_user.id, OWNER))

  await seedUser(OWNER)
  const [p] = await db
    .insert(projects)
    .values({ organizationId: 'org_03', slug: 's03', name: 'P03' })
    .returning()
  projectId = p.id
  await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 5, urgentPerHour: 2 })
  await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })
  agentId = await freshAgent(projectId, OWNER, 'alpha')
})

afterAll(async () => {
  await db.$client.end()
})

describe('reserve - 롤링 하드캡', () => {
  it('N회까지 허용, N+1회째 거부(cap)', async () => {
    // wakesPerHour=5. 5개의 정산 이벤트(윈도우 내)를 심는다.
    for (let i = 0; i < 5; i++) {
      await db
        .insert(wakeEvents)
        .values({ ownerUserId: OWNER, agentId, projectId, urgent: false, suppressed: false })
    }
    const r = await reserve(db, { ownerUserId: OWNER, projectId, urgent: false })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('cap')
  })

  it('윈도우 밖(60분 초과) 이벤트는 카운트 안 함', async () => {
    const old = new Date(Date.now() - WINDOW_MS - 60_000) // 61분 전
    for (let i = 0; i < 5; i++) {
      await db.insert(wakeEvents).values({
        ownerUserId: OWNER,
        agentId,
        projectId,
        urgent: false,
        suppressed: false,
        createdAt: old,
      })
    }
    const r = await reserve(db, { ownerUserId: OWNER, projectId, urgent: false })
    expect(r.allowed).toBe(true) // 오래된 5개는 안 세므로 캡 여유
    expect(r.reason).toBe('ok')
  })

  it('suppressed=true 이벤트는 카운트 안 함(넛지 안 났으므로)', async () => {
    for (let i = 0; i < 5; i++) {
      await db
        .insert(wakeEvents)
        .values({ ownerUserId: OWNER, agentId, projectId, urgent: false, suppressed: true })
    }
    const r = await reserve(db, { ownerUserId: OWNER, projectId, urgent: false })
    expect(r.allowed).toBe(true)
  })

  it('phantom=true 이벤트는 카운트 안 함(실발급 안 됐으므로, REL-1)', async () => {
    for (let i = 0; i < 5; i++) {
      await db
        .insert(wakeEvents)
        .values({ ownerUserId: OWNER, agentId, projectId, urgent: false, suppressed: false, phantom: true })
    }
    const r = await reserve(db, { ownerUserId: OWNER, projectId, urgent: false })
    expect(r.allowed).toBe(true) // phantom 5개는 예산을 소진시키지 않음
    expect(r.reason).toBe('ok')
  })

  it('in-flight pending wakeIntent도 카운트(예약이 점유)', async () => {
    // 별도 agent들로 5개의 pending intent 심기(코얼레싱 유니크 회피).
    for (let i = 0; i < 5; i++) {
      const aid = await freshAgent(projectId, OWNER, `p${i}`)
      await db.insert(wakeIntents).values({
        agentId: aid,
        projectId,
        ownerUserId: OWNER,
        state: 'pending',
        epoch: 0,
        urgent: false,
        expiresAt: new Date(Date.now() + 600_000),
      })
    }
    const r = await reserve(db, { ownerUserId: OWNER, projectId, urgent: false })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('cap')
  })

  it('만료/취소된 intent는 카운트 안 함(자동 환불 모델)', async () => {
    for (let i = 0; i < 5; i++) {
      const aid = await freshAgent(projectId, OWNER, `e${i}`)
      await db.insert(wakeIntents).values({
        agentId: aid,
        projectId,
        ownerUserId: OWNER,
        state: 'expired',
        epoch: 0,
        urgent: false,
        expiresAt: new Date(Date.now() - 600_000),
      })
    }
    const r = await reserve(db, { ownerUserId: OWNER, projectId, urgent: false })
    expect(r.allowed).toBe(true) // expired는 종료 상태 = 환불됨
  })
})

describe('reserve - urgent 별도 허용량 U', () => {
  it('urgent는 일반 N이 아니라 U를 쓴다', async () => {
    // 일반 캡(5)을 꽉 채워도 urgent는 U(2)로 별도 판정.
    for (let i = 0; i < 5; i++) {
      await db
        .insert(wakeEvents)
        .values({ ownerUserId: OWNER, agentId, projectId, urgent: false, suppressed: false })
    }
    const r = await reserve(db, { ownerUserId: OWNER, projectId, urgent: true })
    expect(r.allowed).toBe(true) // urgent 카운트는 0/2
    expect(r.reason).toBe('ok')
  })

  it('urgent U 초과 시 거부(urgent_cap)', async () => {
    for (let i = 0; i < 2; i++) {
      await db
        .insert(wakeEvents)
        .values({ ownerUserId: OWNER, agentId, projectId, urgent: true, suppressed: false })
    }
    const r = await reserve(db, { ownerUserId: OWNER, projectId, urgent: true })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('urgent_cap')
  })

  it('U=0이면 urgent 영구 차단(urgent_zero)', async () => {
    await db.update(ownerWakeBudgets).set({ urgentPerHour: 0 }).where(eq(ownerWakeBudgets.userId, OWNER))
    const r = await reserve(db, { ownerUserId: OWNER, projectId, urgent: true })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('urgent_zero')
  })
})

describe('reserve - no_owner', () => {
  it('ownerUserId null이면 안전하게 거부(no_owner)', async () => {
    const r = await reserve(db, { ownerUserId: null, projectId, urgent: false })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('no_owner')
  })
})

describe('reserve - 프로젝트 floor 격리', () => {
  it('한 프로젝트가 캡을 다 먹어도 다른 프로젝트는 floor로 살아남는다', async () => {
    // 소유자 예산을 넉넉히(wakesPerHour=10), floor = max(floor(10*0.2)=2, 5) = 5.
    await db.update(ownerWakeBudgets).set({ wakesPerHour: 10 }).where(eq(ownerWakeBudgets.userId, OWNER))

    // 두 번째 프로젝트(굶주린 쪽) + 같은 owner 멤버십.
    const [p2] = await db
      .insert(projects)
      .values({ organizationId: 'org_03', slug: 's03b', name: 'P03b' })
      .returning()
    await db.insert(projectAccess).values({ projectId: p2.id, userId: OWNER, level: 'write' })

    // 시끄러운 프로젝트(projectId)가 10개 모두 점유 → 소유자 총 캡 도달.
    for (let i = 0; i < 10; i++) {
      await db
        .insert(wakeEvents)
        .values({ ownerUserId: OWNER, agentId, projectId, urgent: false, suppressed: false })
    }

    // 시끄러운 프로젝트의 추가 요청 → 거부(자기 floor 5 이미 초과, 총 캡 도달).
    const noisy = await reserve(db, { ownerUserId: OWNER, projectId, urgent: false })
    expect(noisy.allowed).toBe(false)
    expect(noisy.reason).toBe('cap')

    // 굶주린 프로젝트(p2)는 자기 카운트 0 < floor 5 → 허용(ok_floor).
    const starved = await reserve(db, { ownerUserId: OWNER, projectId: p2.id, urgent: false })
    expect(starved.allowed).toBe(true)
    expect(starved.reason).toBe('ok_floor')
  })

  it('priority 프로젝트는 더 큰 floor 지분을 받는다', async () => {
    await db.update(ownerWakeBudgets).set({ wakesPerHour: 10 }).where(eq(ownerWakeBudgets.userId, OWNER))
    await db
      .update(projectAccess)
      .set({ wakePriority: true })
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, OWNER)))
    const floor = await projectFloor(db, OWNER, projectId, 10)
    expect(floor).toBe(10) // base 5 * PRIORITY_MULTIPLIER 2
  })
})

describe('settle - 정산 이벤트', () => {
  it('활성화 시 wakeEvents(suppressed=false) 1행을 쓰고 intent를 done으로', async () => {
    const [intent] = await db
      .insert(wakeIntents)
      .values({
        agentId,
        projectId,
        ownerUserId: OWNER,
        state: 'activated',
        epoch: 0,
        urgent: true,
        expiresAt: new Date(Date.now() + 600_000),
      })
      .returning()

    await settle(db, intent.id)

    const events = await db.select().from(wakeEvents).where(eq(wakeEvents.wakeIntentId, intent.id))
    expect(events).toHaveLength(1)
    expect(events[0].suppressed).toBe(false)
    expect(events[0].urgent).toBe(true) // intent의 urgent를 전파
    expect(events[0].ownerUserId).toBe(OWNER)
    const [after] = await db.select().from(wakeIntents).where(eq(wakeIntents.id, intent.id))
    expect(after.state).toBe('done')
    expect(after.settledAt).not.toBeNull()
  })

  it('이미 done인 intent를 다시 settle해도 이벤트가 중복 생성되지 않는다(멱등)', async () => {
    const [intent] = await db
      .insert(wakeIntents)
      .values({
        agentId,
        projectId,
        ownerUserId: OWNER,
        state: 'activated',
        epoch: 0,
        urgent: false,
        expiresAt: new Date(Date.now() + 600_000),
      })
      .returning()
    await settle(db, intent.id)
    await settle(db, intent.id) // 두 번째 호출 = no-op
    const events = await db.select().from(wakeEvents).where(eq(wakeEvents.wakeIntentId, intent.id))
    expect(events).toHaveLength(1)
  })
})

describe('sweepEligible - 회수 후보', () => {
  it('예산이 풀리면 억제됐던(suppressed) part를 재예약 후보로 반환', async () => {
    // 과거에 억제된 이벤트(suppressed=true)가 있던 agent + 현재 활성 intent 없음 = idle.
    await db
      .insert(wakeEvents)
      .values({ ownerUserId: OWNER, agentId, projectId, urgent: false, suppressed: true })
    const candidates = await sweepEligible(db, OWNER)
    expect(candidates.map(c => c.agentId)).toContain(agentId)
    expect(candidates[0].allowed).toBe(true) // 캡 여유 있음(suppressed는 카운트 0)
  })

  it('이미 활성 wake가 있는(코얼레싱) part는 후보에서 제외', async () => {
    await db
      .insert(wakeEvents)
      .values({ ownerUserId: OWNER, agentId, projectId, urgent: false, suppressed: true })
    await db.insert(wakeIntents).values({
      agentId,
      projectId,
      ownerUserId: OWNER,
      state: 'pending',
      epoch: 0,
      urgent: false,
      expiresAt: new Date(Date.now() + 600_000),
    })
    const candidates = await sweepEligible(db, OWNER)
    expect(candidates.map(c => c.agentId)).not.toContain(agentId)
  })

  it('캡이 여전히 꽉 차 있으면 후보지만 allowed=false', async () => {
    await db
      .insert(wakeEvents)
      .values({ ownerUserId: OWNER, agentId, projectId, urgent: false, suppressed: true })
    for (let i = 0; i < 5; i++) {
      const aid = await freshAgent(projectId, OWNER, `f${i}`)
      await db
        .insert(wakeEvents)
        .values({ ownerUserId: OWNER, agentId: aid, projectId, urgent: false, suppressed: false })
    }
    const cand = (await sweepEligible(db, OWNER)).find(c => c.agentId === agentId)
    expect(cand?.allowed).toBe(false) // 캡 도달 + floor도 못 넘김
  })
})
