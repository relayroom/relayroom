"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { PencilIcon, CheckIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateAgent } from "@/modules/agent/actions"

const schema = z.object({
  nickname: z.string().max(100).optional(),
  badge: z.string().max(200).optional(),
})

type FormValues = z.infer<typeof schema>

interface AgentEditFormProps {
  agentId: string
  /** The agent's part - the primary identifier shown as the heading. */
  part: string
  nickname: string | null
  badge: string | null
}

export function AgentEditForm({ agentId, part, nickname, badge }: AgentEditFormProps) {
  const router = useRouter()
  const t = useTranslations("project")
  const [editing, setEditing] = useState(false)
  const [isPending, startTransition] = useTransition()

  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      nickname: nickname ?? "",
      badge: badge ?? "",
    },
  })

  function handleCancel() {
    reset({ nickname: nickname ?? "", badge: badge ?? "" })
    setEditing(false)
  }

  function onSubmit(data: FormValues) {
    const action = updateAgent({
      agentId,
      nickname: data.nickname,
      badge: data.badge,
    })

    toast.promise(action, {
      loading: t("agentEdit.toastSaving"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("agentEdit.genericError"))
        setEditing(false)
        router.refresh()
        return t("agentEdit.toastSaved")
      },
      error: (err: unknown) => {
        const msg = err instanceof Error ? err.message : t("agentEdit.toastError")
        return msg
      },
    })

    startTransition(async () => {
      await action
    })
  }

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl font-bold font-mono">{part}</span>
            {nickname && <span className="text-base text-muted-foreground">{nickname}</span>}
          </div>
          {badge && <p className="text-sm text-muted-foreground">{badge}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          <PencilIcon className="h-3.5 w-3.5 mr-1.5" />
          {t("agentEdit.editButton")}
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="nickname" className="text-xs">{t("agentEdit.nicknameLabel")}</Label>
        <Input
          id="nickname"
          {...register("nickname")}
          placeholder={t("agentEdit.nicknamePlaceholder")}
          className="h-8 text-sm"
          disabled={isPending}
        />
        {errors.nickname && (
          <p className="text-xs text-destructive">{errors.nickname.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="badge" className="text-xs">{t("agentEdit.badgeLabel")}</Label>
        <Input
          id="badge"
          {...register("badge")}
          placeholder={t("agentEdit.badgePlaceholder")}
          className="h-8 text-sm"
          disabled={isPending}
        />
        {errors.badge && (
          <p className="text-xs text-destructive">{errors.badge.message}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          <CheckIcon className="h-3.5 w-3.5 mr-1.5" />
          {t("agentEdit.save")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={handleCancel}>
          <XIcon className="h-3.5 w-3.5 mr-1.5" />
          {t("agentEdit.cancel")}
        </Button>
      </div>
    </form>
  )
}
