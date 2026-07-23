"use client"

import { useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { BotIcon, PlusIcon, FolderPlusIcon } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { connectAgent } from "@/modules/agent/actions"
import { connectAgentSchema, toPartSlug, toPartSlugLive, type ConnectAgentInput } from "@/modules/agent/schema"
import { AGENT_COLORS, AGENT_ICONS, AgentAvatar, resolveAgentColor } from "@/components/agent/agent-appearance"
import { AgentStatusBadge } from "@/components/agent/agent-status-badge"

export interface ConnectableProject {
  id: string
  slug: string
  name: string
  connectCode: string | null
}

interface Props {
  /** Single-project mode (project tab): the project's connect code + name. */
  connectCode?: string
  projectName?: string
  /** Picker mode (global Agents page): choose among connectable projects. */
  projects?: ConnectableProject[]
  /** Override the trigger button label. */
  triggerLabel?: string
}

/**
 * Registers a named agent (identity/seat) in a project - one job. On success it
 * navigates to the new agent's detail page, which auto-opens the connect guide.
 * The "connect your local coding tool to this agent" step lives in a separate
 * dialog (AgentConnectGuideDialog), so each dialog does exactly one thing.
 */
export function AgentRegisterDialog({ connectCode, projectName, projects, triggerLabel }: Props) {
  const t = useTranslations("project")
  // The schema carries user-facing validation copy, so it is built from the
  // `errors` translator (see modules/thread/schema.ts). Memoized because a new
  // schema object on every render would rebuild the resolver each time.
  const tErrors = useTranslations("errors")
  const schema = useMemo(() => connectAgentSchema(tErrors), [tErrors])
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [color, setColor] = useState<string | null>(null)
  const [icon, setIcon] = useState<string>("bot")
  const [showAppearance, setShowAppearance] = useState(false)

  const isPicker = Array.isArray(projects)
  const [selectedProjectId, setSelectedProjectId] = useState(projects?.[0]?.id ?? "")
  const activeProject = projects?.find((p) => p.id === selectedProjectId) ?? projects?.[0]
  const noProjects = isPicker && projects!.length === 0
  const effectiveCode = (isPicker ? activeProject?.connectCode : connectCode) ?? ""
  const effectiveName = (isPicker ? activeProject?.name : projectName) ?? ""

  const form = useForm<ConnectAgentInput>({
    resolver: zodResolver(schema),
    defaultValues: { connectCode: effectiveCode, part: "", nickname: "" },
  })
  const partValue = form.watch("part")
  const nicknameValue = form.watch("nickname")
  const resolvedColor = resolveAgentColor(color, partValue || "agent").key

  function handleOpenChange(v: boolean) {
    if (!v) {
      setColor(null)
      setIcon("bot")
      setShowAppearance(false)
      form.reset({ connectCode: effectiveCode, part: "", nickname: "" })
    }
    setOpen(v)
  }

  async function onSubmit(values: ConnectAgentInput) {
    // toast.promise() returns a toast id (a string), NOT the awaitable promise, so
    // `await toast.promise(...)` would resolve immediately and let handleSubmit clear
    // isSubmitting before the action settles (double submit). Await the action itself.
    const p = connectAgent({ ...values, connectCode: effectiveCode, color: color ?? undefined, icon })
    toast.promise(p, {
      loading: t("agentRegister.toastSaving"),
      success: (res) => {
        if (!res.result) throw new Error(res.message)
        setOpen(false)
        // Land on the new agent's detail page, which auto-opens the connect guide.
        router.push(`/projects/${res.item.projectSlug}/agents/${res.item.agentId}?connect=1`)
        return t("agentRegister.toastSaved")
      },
      error: (err: unknown) => (err instanceof Error ? err.message : t("agentRegister.toastError")),
    })
    await p.catch(() => {})
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <span className="relative mr-1.5 inline-flex">
          <BotIcon className="size-[18px]" />
          <PlusIcon className="absolute -right-1.5 -top-0.5 size-2.5 rounded-full bg-background" strokeWidth={2.75} />
        </span>
        {triggerLabel ?? t("agents.connectButton")}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("agentRegister.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {effectiveName
              ? t.rich("agentRegister.dialogDescription", { projectName: () => <strong>{effectiveName}</strong> })
              : t("agentRegister.dialogDescriptionGeneric")}
          </DialogDescription>
        </DialogHeader>

        {noProjects ? (
          <div className="space-y-4 py-2 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <FolderPlusIcon className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">{t("agentConnect.noProjectsTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("agentConnect.noProjectsBody")}</p>
            </div>
            <Button render={<Link href="/projects/new" />} size="sm" className="w-full">
              <FolderPlusIcon className="mr-1.5 h-4 w-4" />
              {t("agentConnect.noProjectsCta")}
            </Button>
          </div>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Live preview */}
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                {t("agentConnect.previewLabel")}
              </p>
              <div className="flex items-center gap-3">
                <AgentAvatar color={resolvedColor} icon={icon} seed={partValue || "agent"} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("truncate font-mono text-sm font-medium", !partValue && "text-muted-foreground/50")}>
                      {partValue || t("agentConnect.partPlaceholder")}
                    </span>
                    {nicknameValue && <span className="truncate text-xs text-muted-foreground">&ldquo;{nicknameValue}&rdquo;</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                    <AgentStatusBadge status="offline" />
                    <span className="opacity-60">{t("agentConnect.previewPending")}</span>
                  </div>
                </div>
              </div>
            </div>

            {isPicker && (
              <div className="space-y-2">
                <Label htmlFor="project">{t("agentConnect.projectLabel")}</Label>
                <select
                  id="project"
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="h-9 w-full cursor-pointer rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {projects!.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="part">{t("agentConnect.partLabel")}</Label>
              {/* part is an identifier baked into tmux/URL/CLI commands - slugify as the
                  user types so spaces/parens never reach the commands. Free-form display
                  names belong in the nickname field below. */}
              <Input
                id="part"
                placeholder={t("agentConnect.partPlaceholder")}
                value={partValue}
                onChange={(e) => form.setValue("part", toPartSlugLive(e.target.value), { shouldValidate: true, shouldDirty: true })}
                onBlur={(e) => form.setValue("part", toPartSlug(e.target.value), { shouldValidate: true })}
              />
              <p className="text-[11px] text-muted-foreground">{t("agentConnect.partHint")}</p>
              {form.formState.errors.part && <p className="text-xs text-destructive">{form.formState.errors.part.message}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="nickname">{t("agentConnect.nicknameLabel")}</Label>
              <Input id="nickname" placeholder={t("agentConnect.nicknamePlaceholder")} {...form.register("nickname")} />
            </div>

            {/* Appearance (secondary) - collapsed behind a toggle */}
            <button
              type="button"
              onClick={() => setShowAppearance((v) => !v)}
              className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <span className="flex items-center gap-2">
                <AgentAvatar color={resolvedColor} icon={icon} seed={partValue || "agent"} size="sm" />
                {t("agentConnect.appearanceToggle")}
              </span>
              <span aria-hidden>{showAppearance ? "▴" : "▾"}</span>
            </button>

            {showAppearance && (
              <>
                <div className="space-y-2">
                  <Label>{t("agentConnect.colorLabel")}</Label>
                  <div className="flex flex-wrap gap-2">
                    {AGENT_COLORS.map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => setColor(c.key)}
                        aria-label={c.key}
                        className={cn(
                          "h-7 w-7 rounded-full transition-transform",
                          c.swatch,
                          resolvedColor === c.key ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : "hover:scale-110",
                        )}
                      />
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t("agentConnect.iconLabel")}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {AGENT_ICONS.map(({ key, Icon }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setIcon(key)}
                        aria-label={key}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-md border transition-colors",
                          icon === key ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
              <BotIcon className="h-4 w-4 mr-1.5" />
              {form.formState.isSubmitting ? t("agentRegister.submittingButton") : t("agentRegister.submitButton")}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
