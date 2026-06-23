"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PlusIcon, SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarkdownEditor } from "@/components/markdown-editor"
import { cn } from "@/lib/utils"
import { createThread } from "@/modules/thread/actions"

interface AgentOption {
  id: string
  part: string
  nickname: string | null
  role: string
}

interface Props {
  slug: string
  projectId: string
  agents: AgentOption[]
}

/**
 * Lets the human START a conversation with an agent from the dashboard (the
 * board's send/wake path previously only worked agent-to-agent; the human could
 * only reply to existing threads). The recipient defaults to the project's main
 * agent. On submit it creates the thread, wakes the addressed parts (server
 * action), and navigates to the new thread.
 */
export function NewThreadButton({ slug, projectId, agents }: Props) {
  const t = useTranslations("project")
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const mainId = agents.find((a) => a.role === "main")?.id ?? null
  const [selected, setSelected] = useState<string[]>(mainId ? [mainId] : [])

  const hasAgents = agents.length > 0
  const hasMain = mainId !== null
  const canSubmit = hasAgents && subject.trim().length > 0 && body.trim().length > 0 && selected.length > 0 && !submitting

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function handleOpenChange(v: boolean) {
    if (!v) {
      setSubject("")
      setBody("")
      setSelected(mainId ? [mainId] : [])
    }
    setOpen(v)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    // Await the action itself (not toast.promise, which returns a toast id) so
    // submitting only clears once the action settles - mirrors AgentRegisterDialog.
    const p = createThread({
      projectId,
      subject: subject.trim(),
      body: body.trim(),
      targetAgentIds: selected,
    })
    toast.promise(p, {
      loading: t("newThread.toastSending"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("newThread.genericError"))
        setOpen(false)
        setSubject("")
        setBody("")
        setSelected(mainId ? [mainId] : [])
        router.push(`/projects/${slug}/threads/${res.item.id}`)
        return t("newThread.toastSent")
      },
      error: (err: unknown) => (err instanceof Error ? err.message : t("newThread.genericError")),
    })
    await p.catch(() => {})
    setSubmitting(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <PlusIcon className="mr-1.5 h-3.5 w-3.5" />
        {t("newThread.button")}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("newThread.title")}</DialogTitle>
          <DialogDescription>{t("newThread.description")}</DialogDescription>
        </DialogHeader>

        {!hasAgents ? (
          <p className="py-4 text-sm text-muted-foreground">{t("newThread.noAgents")}</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="subject">{t("newThread.subjectLabel")}</Label>
              <Input
                id="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={t("newThread.subjectPlaceholder")}
                maxLength={200}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label>{t("newThread.bodyLabel")}</Label>
              <MarkdownEditor
                value={body}
                onChange={setBody}
                disabled={submitting}
                rows={5}
                placeholder={t("newThread.bodyPlaceholder")}
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t("newThread.recipientsLabel")}</p>
              <div className="flex flex-wrap gap-1.5">
                {agents.map((agent) => {
                  const isSelected = selected.includes(agent.id)
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => toggle(agent.id)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-mono font-medium transition-colors",
                        isSelected
                          ? "border-foreground bg-foreground text-background"
                          : "border-border bg-background text-muted-foreground hover:border-foreground/50 hover:text-foreground",
                      )}
                    >
                      {agent.part}
                      {agent.role === "main" && (
                        <span className="font-sans opacity-70">{t("newThread.mainBadge")}</span>
                      )}
                      {agent.nickname && <span className="font-sans opacity-70">&ldquo;{agent.nickname}&rdquo;</span>}
                    </button>
                  )
                })}
              </div>
              {!hasMain && (
                <p className="text-[11px] text-muted-foreground">
                  {t("newThread.noMainHint")}{" "}
                  <Link href={`/projects/${slug}/agents`} className="underline underline-offset-2 hover:text-foreground">
                    {t("agents.pageTitle")}
                  </Link>
                </p>
              )}
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
                {t("newThread.cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                <SendIcon className="mr-1.5 h-3.5 w-3.5" />
                {t("newThread.submit")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
