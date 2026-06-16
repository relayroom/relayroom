"use client"

import { useState, useTransition } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MarkdownEditor } from "@/components/markdown-editor"
import { postMessage } from "@/modules/thread/actions"

interface TargetAgent {
  id: string
  part: string
  nickname: string | null
}

interface ThreadReplyFormProps {
  threadId: string
  targetAgents: TargetAgent[]
}

export function ThreadReplyForm({ threadId, targetAgents }: ThreadReplyFormProps) {
  const t = useTranslations("project")
  const [body, setBody] = useState("")
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [isPending, startTransition] = useTransition()

  function toggleAgent(id: string) {
    setSelectedAgentIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    )
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim()) return

    const action = postMessage({
      threadId,
      body: body.trim(),
      targetAgentIds: selectedAgentIds.length > 0 ? selectedAgentIds : undefined,
    })

    toast.promise(action, {
      loading: t("threadReply.toastSending"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("threadReply.genericError"))
        setBody("")
        return t("threadReply.toastSent")
      },
      error: (err: unknown) => {
        const msg = err instanceof Error ? err.message : t("threadReply.toastError")
        return msg
      },
    })

    startTransition(async () => {
      await action
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <MarkdownEditor
        value={body}
        onChange={setBody}
        disabled={isPending}
        rows={5}
        placeholder={t("threadReply.messagePlaceholder")}
      />

      {targetAgents.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t("threadReply.targetAgents")}</p>
          <div className="flex flex-wrap gap-1.5">
            {targetAgents.map((agent) => {
              const selected = selectedAgentIds.includes(agent.id)
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => toggleAgent(agent.id)}
                  className={[
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-mono font-medium transition-colors",
                    selected
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:border-foreground/50 hover:text-foreground",
                  ].join(" ")}
                >
                  {agent.part}
                  {agent.nickname && (
                    <span className="font-sans opacity-70">"{agent.nickname}"</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={isPending || !body.trim()}>
          <SendIcon className="h-3.5 w-3.5 mr-1.5" />
          {t("threadReply.send")}
        </Button>
      </div>
    </form>
  )
}
