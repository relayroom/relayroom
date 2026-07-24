"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CheckIcon, XIcon, Loader2Icon, FlaskConicalIcon, AlertCircleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/use-confirm"
import { decideProposalAction } from "@/modules/knowledge/proposal-actions"

export interface ProposalCardData {
  id: string
  status: string
  target: string
  evidence: { signature?: string; count?: number; agents?: number }
  hypothesis: string
  disconfirming: string | null
  change: Record<string, unknown>
}

/** Status badge tone: adopted reads settled, rejected muted. */
function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "approved") return "default"
  if (status === "pending") return "secondary"
  return "outline"
}

function titleKey(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function ProposalCard({ projectId, data }: { projectId: string; data: ProposalCardData }) {
  const t = useTranslations("project")
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [pending, setPending] = useState<null | "approved" | "rejected">(null)

  const isKnowledge = data.target === "knowledge"
  const change = data.change as {
    title?: string
    body?: string
    kind?: string
    content?: string
    patch?: string
  }

  async function decide(decision: "approved" | "rejected") {
    const ok = await confirm({
      title:
        decision === "approved"
          ? t("knowledgeProposals.approveConfirmTitle")
          : t("knowledgeProposals.rejectConfirmTitle"),
      description:
        decision === "rejected"
          ? t("knowledgeProposals.rejectConfirmBody")
          : isKnowledge
            ? t("knowledgeProposals.approveConfirmKnowledge")
            : t("knowledgeProposals.approveConfirmPlaybook"),
      destructive: decision === "rejected",
    })
    if (!ok) return

    setPending(decision)
    const request = decideProposalAction(projectId, data.id, decision).then((res) => {
      if (!res.result) throw new Error(res.message ?? t("knowledgeProposals.actionError"))
      return res
    })
    toast.promise(request, {
      loading: t("knowledgeProposals.approvePending"),
      success: () => {
        router.refresh()
        if (decision === "rejected") return t("knowledgeProposals.rejectDone")
        return isKnowledge
          ? t("knowledgeProposals.approveDoneKnowledge")
          : t("knowledgeProposals.approveDonePlaybook")
      },
      error: (err: unknown) => (err instanceof Error ? err.message : t("knowledgeProposals.actionError")),
    })
    await request.catch(() => {})
    setPending(null)
  }

  return (
    <li className="space-y-3 rounded-lg border border-border p-4">
      {confirmDialog}

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-xs">
          {t(`knowledgeProposals.target${titleKey(data.target)}` as Parameters<typeof t>[0])}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{data.hypothesis}</span>
        <Badge variant={statusVariant(data.status)} className="shrink-0 text-xs">
          {t(`knowledgeProposals.status${titleKey(data.status)}` as Parameters<typeof t>[0])}
        </Badge>
      </div>

      {/* Evidence */}
      {(data.evidence.count != null || data.evidence.agents != null) && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FlaskConicalIcon className="h-3 w-3" />
          {t("knowledgeProposals.evidenceCount", {
            count: data.evidence.count ?? 0,
            agents: data.evidence.agents ?? 0,
          })}
        </p>
      )}

      {/* Disconfirming - the condition that would make this wrong. Shown because a
          proposal you cannot falsify is not an argument. */}
      {data.disconfirming && (
        <div className="rounded-md bg-muted/40 p-2 text-xs">
          <span className="flex items-center gap-1 font-medium text-muted-foreground">
            <AlertCircleIcon className="h-3 w-3" />
            {t("knowledgeProposals.sectionDisconfirming")}
          </span>
          <p className="mt-0.5 text-muted-foreground">{data.disconfirming}</p>
        </div>
      )}

      {/* The concrete change */}
      <div className="space-y-1.5 rounded-md border border-border p-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {t("knowledgeProposals.sectionChange")}
        </p>
        {isKnowledge ? (
          <div className="space-y-1 text-xs">
            {change.kind && (
              <p>
                <span className="text-muted-foreground">{t("knowledgeProposals.changeKind")}: </span>
                <span className="font-mono">{change.kind}</span>
              </p>
            )}
            {change.title && (
              <p>
                <span className="text-muted-foreground">{t("knowledgeProposals.changeTitle")}: </span>
                {change.title}
              </p>
            )}
            {change.body && (
              <p className="whitespace-pre-wrap text-muted-foreground">{change.body}</p>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">{t("knowledgeProposals.playbookDiffLabel")}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">
              {change.patch ?? change.content ?? ""}
            </pre>
          </div>
        )}
      </div>

      {data.status === "pending" && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => decide("rejected")} disabled={pending !== null}>
            {pending === "rejected" ? (
              <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <XIcon className="mr-1 h-3.5 w-3.5" />
            )}
            {t("knowledgeProposals.rejectButton")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => decide("approved")} disabled={pending !== null}>
            {pending === "approved" ? (
              <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckIcon className="mr-1 h-3.5 w-3.5" />
            )}
            {t("knowledgeProposals.approveButton")}
          </Button>
        </div>
      )}
    </li>
  )
}
