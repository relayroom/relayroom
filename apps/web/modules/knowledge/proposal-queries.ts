import { and, count, desc, eq } from "drizzle-orm"
import { db } from "@/modules/drizzle/db"
import { knowledgeProposals, playbookVersions } from "@relayroom/db/schema"

// ── Proposal queue ──────────────────────────────────────────────────────────

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "superseded"] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export function isProposalStatus(v: string): v is ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(v)
}

/** The proposer's argument for one proposed change - shown so a human can judge it. */
export interface ProposalRow {
  id: string
  status: string
  target: string
  evidence: { signature?: string; eventIds?: string[]; knowledgeIds?: string[]; count?: number; agents?: number }
  hypothesis: string
  disconfirming: string | null
  /** knowledge: {title, body, kind}. playbook: {content, patch?}. */
  change: Record<string, unknown>
  triggerSignature: string | null
  decidedAt: Date | null
  createdAt: Date
}

/**
 * Proposals for a project, newest first, optionally narrowed to one status.
 *
 * Scoped by projectId alone: the /knowledge/proposals page has already proven
 * owner access before it renders, and every decision action re-checks. This only
 * reads the queue.
 */
export async function listProposals(
  projectId: string,
  status?: ProposalStatus,
): Promise<ProposalRow[]> {
  const where = status
    ? and(eq(knowledgeProposals.projectId, projectId), eq(knowledgeProposals.status, status))
    : eq(knowledgeProposals.projectId, projectId)

  return db
    .select({
      id: knowledgeProposals.id,
      status: knowledgeProposals.status,
      target: knowledgeProposals.target,
      evidence: knowledgeProposals.evidence,
      hypothesis: knowledgeProposals.hypothesis,
      disconfirming: knowledgeProposals.disconfirming,
      change: knowledgeProposals.change,
      triggerSignature: knowledgeProposals.triggerSignature,
      decidedAt: knowledgeProposals.decidedAt,
      createdAt: knowledgeProposals.createdAt,
    })
    .from(knowledgeProposals)
    .where(where)
    .orderBy(desc(knowledgeProposals.createdAt)) as Promise<ProposalRow[]>
}

/** How many proposals await a decision - drives the "Proposals (N pending)" badge. */
export async function countPendingProposals(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(knowledgeProposals)
    .where(and(eq(knowledgeProposals.projectId, projectId), eq(knowledgeProposals.status, "pending")))
  return Number(row?.n ?? 0)
}

/** Count per status, for the filter tabs. */
export async function countProposalsByStatus(projectId: string): Promise<Record<ProposalStatus, number>> {
  const empty: Record<ProposalStatus, number> = { pending: 0, approved: 0, rejected: 0, superseded: 0 }
  const rows = await db
    .select({ status: knowledgeProposals.status, n: count() })
    .from(knowledgeProposals)
    .where(eq(knowledgeProposals.projectId, projectId))
    .groupBy(knowledgeProposals.status)
  const out = { ...empty }
  for (const r of rows) if (isProposalStatus(r.status)) out[r.status] = Number(r.n)
  return out
}

// ── Playbook version history ─────────────────────────────────────────────────

export interface PlaybookVersionRow {
  version: number
  content: string
  contentHash: string
  note: string | null
  createdAt: Date
}

/**
 * A project's playbook version history, newest first. Append-only: a rollback is
 * a new version equal to an old one, so the list only ever grows and the current
 * served body is the highest version.
 */
export async function listPlaybookVersions(projectId: string): Promise<PlaybookVersionRow[]> {
  return db
    .select({
      version: playbookVersions.version,
      content: playbookVersions.content,
      contentHash: playbookVersions.contentHash,
      note: playbookVersions.note,
      createdAt: playbookVersions.createdAt,
    })
    .from(playbookVersions)
    .where(eq(playbookVersions.projectId, projectId))
    .orderBy(desc(playbookVersions.version))
}
