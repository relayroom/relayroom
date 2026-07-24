/**
 * POST /api/knowledge/attest - the CI attestation promotion channel (FEAT-0001 L1).
 *
 * This is a plain HTTP route, NOT an MCP tool, and that is the point. An agent
 * reaches the MCP tools with a project connect code; it cannot reach this. Promotion
 * to `trusted` - the one dangerous direction, the one that spreads a claim to every
 * other agent - is available only through a channel a work agent has no key for. An
 * agent can demote (contradict) and nothing else.
 *
 * The trust boundary is stated honestly (design 04): a signed attestation delegates
 * trust to whoever controls the CI secret and the check->claim map. RelayRoom's
 * claim is narrower and exact - the WORK AGENT ALONE cannot self-promote - and the
 * mechanism for that is that the whole CI system counts as ONE issuer, so reaching
 * K distinct promoting issuers needs a second principal (a human, or a second
 * issuer a manager designates). That counting lives in recordKnowledgeSignal; this
 * endpoint's job is to let only genuinely-signed, non-replayed, correctly-mapped
 * attestations become one CI `support` signal.
 */
import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { knowledge, knowledgeCheckMap, knowledgeNonces, projects } from '@relayroom/db'
import { recordKnowledgeSignal } from '@relayroom/db'
import { Hono } from 'hono'
import { type AttestClaim, verifyAttest } from '../knowledge/attest-canonical'
import { checkAttestSkew } from '../knowledge/attest-skew'

/** The whole CI system is one promoting issuer by default (design 04, R14): K
 *  independent supports cannot be manufactured from a single secret, so every CI
 *  run shares this identity and counts once. Per-issuer CI identities are a manager
 *  configuration that L1 does not ship. */
const CI_ISSUER_ID = 'ci'

/** The only assertion L1 understands. A future value is opened deliberately, not by
 *  quietly accepting an unknown one. */
const SUPPORTED_ASSERTION = 'check_passed'

/** sha256(runId + checkName): the dedup key. The same CI run re-posting the same
 *  check is one source, counted once, no matter how many times it fires. */
function sourceFingerprint(runId: string, checkName: string): string {
  return createHash('sha256').update(`${runId}\n${checkName}`).digest('hex')
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Pull the eight signed fields out of an untrusted body, or null if any is missing
 *  or not a string. Extra fields are ignored - they are not signed and cannot be. */
function parseClaim(body: unknown): AttestClaim | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const fields = ['projectId', 'knowledgeId', 'runId', 'checkName', 'assertion', 'keyId', 'issuedAt', 'nonce'] as const
  for (const f of fields) if (!isNonEmptyString(b[f])) return null
  return {
    projectId: b.projectId as string,
    knowledgeId: b.knowledgeId as string,
    runId: b.runId as string,
    checkName: b.checkName as string,
    assertion: b.assertion as string,
    keyId: b.keyId as string,
    issuedAt: b.issuedAt as string,
    nonce: b.nonce as string,
  }
}

export function createAttestRoute(db: Db) {
  const route = new Hono()

  route.post('/', async (c) => {
    const signature = c.req.header('X-RR-Attest-Signature') ?? ''
    const body = await c.req.json().catch(() => null)
    const claim = parseClaim(body)

    // ── format (400) ──────────────────────────────────────────────────────────
    // Shape and the assertion value are format checks, refused before we look at
    // the signature: an unknown assertion is a client that is out of contract, not
    // an authentication failure.
    if (!claim || !isNonEmptyString(signature)) {
      return c.json({ error: 'malformed attestation' }, 400)
    }
    if (claim.assertion !== SUPPORTED_ASSERTION) {
      return c.json({ error: `unsupported assertion; expected '${SUPPORTED_ASSERTION}'` }, 400)
    }

    // ── authentication (401) ──────────────────────────────────────────────────
    // The project is looked up only to reach its secret. A missing project, a
    // disabled secret (null), and a keyId matching no slot are ALL 401 and
    // indistinguishable from outside: whether a project has attestation enabled is
    // not something an unauthenticated caller should be able to probe. A 404 here
    // would leak exactly that.
    const [project] = await db
      .select({
        keyId: projects.attestKeyId,
        secret: projects.attestSecret,
        keyIdPrev: projects.attestKeyIdPrev,
        secretPrev: projects.attestSecretPrev,
        prevExpiresAt: projects.attestSecretPrevExpiresAt,
      })
      .from(projects)
      .where(and(eq(projects.id, claim.projectId), isNull(projects.archivedAt)))
      .limit(1)

    const secret = selectSecret(project, claim.keyId)
    if (!secret || !verifyAttest(claim, secret, signature)) {
      return c.json({ error: 'invalid signature' }, 401)
    }

    // ── clock skew (400) ──────────────────────────────────────────────────────
    const skew = checkAttestSkew(claim.issuedAt, new Date())
    if (!skew.ok) {
      return c.json({ error: skew.reason === 'malformed' ? 'invalid issuedAt' : 'issuedAt outside skew window' }, 400)
    }

    // ── tenant boundary (404) ─────────────────────────────────────────────────
    // The knowledge entry must belong to the project that signed. Checked here even
    // though recordKnowledgeSignal enforces it too: a signed request pointed at
    // another project's claim should be told 404, and it should not spend a nonce
    // doing so. The composite FK on knowledge_check_map backs the same rule at the
    // schema level.
    const [entry] = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(eq(knowledge.id, claim.knowledgeId), eq(knowledge.projectId, claim.projectId)))
      .limit(1)
    if (!entry) {
      return c.json({ error: 'unknown knowledge for this project' }, 404)
    }

    // ── replay (409) ──────────────────────────────────────────────────────────
    // A validly-signed request is spendable exactly once. Insert the nonce after
    // the signature and tenant checks so a forged or misdirected request cannot
    // burn a nonce it never earned; a duplicate (project_id, nonce) is the replay.
    const nonced = await db
      .insert(knowledgeNonces)
      .values({ projectId: claim.projectId, nonce: claim.nonce })
      .onConflictDoNothing()
      .returning({ nonce: knowledgeNonces.nonce })
    if (nonced.length === 0) {
      return c.json({ error: 'attestation already seen (replay)' }, 409)
    }

    // ── counting ──────────────────────────────────────────────────────────────
    // counted = a manager mapped THIS check to THIS claim. An unmapped attestation
    // is recorded for the audit trail but never enters the promotion count, so a CI
    // job cannot attest a claim nobody authorized it to speak for.
    const [mapped] = await db
      .select({ id: knowledgeCheckMap.id })
      .from(knowledgeCheckMap)
      .where(and(
        eq(knowledgeCheckMap.projectId, claim.projectId),
        eq(knowledgeCheckMap.checkName, claim.checkName),
        eq(knowledgeCheckMap.knowledgeId, claim.knowledgeId),
      ))
      .limit(1)
    const counted = !!mapped

    // recordKnowledgeSignal owns the FOR UPDATE re-count and the promotion decision;
    // this only hands it one CI `support` signal. issuerId is the shared CI identity,
    // so many green runs are one voice toward K.
    const result = await recordKnowledgeSignal(db, {
      projectId: claim.projectId,
      knowledgeId: claim.knowledgeId,
      signal: 'support',
      issuer: 'ci_attest',
      issuerId: CI_ISSUER_ID,
      sourceFingerprint: sourceFingerprint(claim.runId, claim.checkName),
      sourceRef: { runId: claim.runId },
      counted,
      actorKind: 'ci',
    })

    // The response is built from the CORE result, not from local values: on a
    // replay-after-dedup, recordKnowledgeSignal returns the ORIGINAL validation's id
    // and its STORED counted flag - resolved inside its own lock - so a replayed
    // request answers with the truth on record rather than whatever this call's body
    // claimed. `counted` computed above only decided what to WRITE on a first insert.
    return c.json({ validationId: result.validationId, counted: result.counted }, 200)
  })

  return route
}

interface AttestKeys {
  keyId: string | null
  secret: string | null
  keyIdPrev: string | null
  secretPrev: string | null
  prevExpiresAt: Date | null
}

/**
 * The secret the body's keyId selects, or null when none applies.
 *
 * Current slot matches on keyId. The previous slot matches only DURING its grace:
 * once `attest_secret_prev_expires_at` has passed, the old key is dead even though
 * the column may not have been swept yet, so an attacker who learned a rotated-out
 * secret cannot keep using it by naming the old keyId.
 */
function selectSecret(keys: AttestKeys | undefined, keyId: string): string | null {
  if (!keys) return null
  if (keys.secret && keys.keyId && keyId === keys.keyId) return keys.secret
  if (
    keys.secretPrev && keys.keyIdPrev && keyId === keys.keyIdPrev
    && keys.prevExpiresAt && keys.prevExpiresAt.getTime() > Date.now()
  ) {
    return keys.secretPrev
  }
  return null
}
