"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { Loader2Icon, RefreshCwIcon, CopyIcon, CheckIcon } from "lucide-react"
import { ProjectIconField } from "@/components/project/project-icon-field"
import { z } from "zod"
import {
  updateProject,
  regenerateConnectCode,
} from "@/modules/project/actions"
import type { ProjectDetail } from "@/modules/project/queries"
import { useConfirm } from "@/components/ui/use-confirm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarkdownEditor } from "@/components/markdown-editor"
import { Separator } from "@/components/ui/separator"

function buildSchema(nameRequired: string) {
  return z.object({
    name: z.string().min(1, nameRequired).max(100),
    summary: z.string().max(200).optional(),
    thumbnailColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    thumbnailUrl: z.string().optional().nullable(),
    backgroundUrl: z.string().optional().nullable(),
  })
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>

interface Props {
  project: ProjectDetail
}

export function ProjectSettingsForm({ project }: Props) {
  const router = useRouter()
  const t = useTranslations("project")
  const [isPending, startTransition] = useTransition()
  const [description, setDescription] = useState(project.description ?? "")
  const [connectCode, setConnectCode] = useState(project.connectCode ?? "")
  const [codeCopied, setCodeCopied] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(buildSchema(t("settings.form.nameRequired"))),
    defaultValues: {
      name: project.name,
      summary: project.summary ?? "",
      thumbnailColor: project.thumbnailColor ?? "",
      backgroundColor: project.backgroundColor ?? "",
      thumbnailUrl: project.thumbnailUrl ?? null,
      backgroundUrl: project.backgroundUrl ?? null,
    },
  })

  const thumbnailColor = watch("thumbnailColor")
  const nameValue = watch("name")

  const onSubmit = (data: FormValues) => {
    startTransition(async () => {
      const p = updateProject({ projectId: project.id, ...data, description })
      toast.promise(p, {
        loading: t("settings.form.toastSaving"),
        success: (res) => {
          if (!res.result) throw new Error(res.message)
          router.refresh()
          return t("settings.form.toastSaved")
        },
        error: (err: Error) => err.message ?? t("settings.form.toastError"),
      })
      await p.catch(() => {}) // keep the transition pending until the action settles
    })
  }

  async function handleRegenerateCode() {
    const ok = await confirm({
      title: t("settings.connectCode.confirmTitle"),
      description: t("settings.connectCode.confirmDescription"),
      confirmText: t("settings.connectCode.confirmText"),
      destructive: true,
    })
    if (!ok) return

    startTransition(async () => {
      const p = regenerateConnectCode(project.id)
      toast.promise(p, {
        loading: t("settings.connectCode.toastRegenerating"),
        success: (res) => {
          if (!res.result) throw new Error(res.message)
          setConnectCode(res.item.connectCode)
          return t("settings.connectCode.toastRegenerated")
        },
        error: (err: Error) => err.message ?? t("settings.connectCode.toastError"),
      })
      await p.catch(() => {}) // keep the transition pending until the action settles
    })
  }

  async function handleCopyCode() {
    if (!connectCode) return
    await navigator.clipboard.writeText(connectCode)
    setCodeCopied(true)
    setTimeout(() => setCodeCopied(false), 2000)
  }

  return (
    <>
      {confirmDialog}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Name */}
        <div className="space-y-1.5">
          <Label htmlFor="name">{t("settings.form.nameLabel")}</Label>
          <div className="flex items-center gap-2">
            <ProjectIconField
              name={nameValue}
              color={thumbnailColor}
              onChange={(c) => setValue("thumbnailColor", c)}
              disabled={isPending}
            />
            <Input id="name" className="flex-1" {...register("name")} disabled={isPending} />
          </div>
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>

        {/* Summary */}
        <div className="space-y-1.5">
          <Label htmlFor="summary">{t("settings.form.summaryLabel")}</Label>
          <Input id="summary" {...register("summary")} disabled={isPending} maxLength={200} />
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <Label>{t("settings.form.descriptionLabel")}</Label>
          <MarkdownEditor
            value={description}
            onChange={setDescription}
            disabled={isPending}
            rows={8}
          />
        </div>

        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isPending}>
            {isPending && <Loader2Icon className="h-4 w-4 mr-2 animate-spin" />}
            {t("settings.form.saveButton")}
          </Button>
        </div>
      </form>

      <Separator />

      {/* Connect code section */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{t("settings.connectCode.sectionTitle")}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settings.connectCode.sectionDescription")}
          </p>
        </div>

        {connectCode ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
            <code className="flex-1 font-mono text-sm">{connectCode}</code>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyCode}
              className="h-7 w-7 p-0"
              aria-label={t("settings.connectCode.copyAriaLabel")}
            >
              {codeCopied ? (
                <CheckIcon className="h-4 w-4 text-emerald-600" />
              ) : (
                <CopyIcon className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("settings.connectCode.noCode")}</p>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={handleRegenerateCode}
          disabled={isPending}
        >
          <RefreshCwIcon className="h-4 w-4 mr-1.5" />
          {t("settings.connectCode.regenerateButton")}
        </Button>
      </div>
    </>
  )
}
