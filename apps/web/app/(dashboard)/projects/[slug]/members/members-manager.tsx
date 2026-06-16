"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { UserPlusIcon, Trash2Icon, BanIcon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { useConfirm } from "@/components/ui/use-confirm"
import {
  addProjectMember,
  updateProjectMemberLevel,
  removeProjectMember,
  banProjectMember,
  unbanProjectMember,
} from "@/modules/project/member-actions"

type Level = "readonly" | "write" | "owner"
const LEVELS: Level[] = ["readonly", "write", "owner"]
function normalizeLevel(v: string): Level {
  return (LEVELS as string[]).includes(v) ? (v as Level) : "write"
}

export interface MemberRow {
  userId: string
  name: string
  email: string
  level: string
  isCreator: boolean
  /** ISO timestamp if banned (reversible), else null. */
  bannedAt: string | null
}
export interface AddableRow {
  userId: string
  name: string
  email: string
}

const selectCls =
  "cursor-pointer rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"

function initials(name: string): string {
  const p = name.trim().split(/\s+/)
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1]![0] : "")).toUpperCase()
}

export function MembersManager({
  projectId,
  members,
  addable,
  canManage,
}: {
  projectId: string
  members: MemberRow[]
  addable: AddableRow[]
  /** Whether the viewer may add/remove/change members (owner or org admin). */
  canManage: boolean
}) {
  const t = useTranslations("project.members")
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [selected, setSelected] = useState("")
  const [level, setLevel] = useState<Level>("write")
  const [busy, setBusy] = useState(false)

  const ownerCount = members.filter((m) => normalizeLevel(m.level) === "owner").length
  const levelLabel: Record<Level, string> = {
    readonly: t("levelReadonly"),
    write: t("levelWrite"),
    owner: t("levelOwner"),
  }

  async function onAdd() {
    if (!selected || busy) return
    setBusy(true)
    try {
      // Await the ACTION, not toast.promise() (which returns a toast-id string and
      // would resolve immediately, releasing the busy guard before the add settles).
      const p = addProjectMember({ projectId, userId: selected, level })
      toast.promise(p, {
        loading: t("toastAdding"),
        success: (res) => {
          if (!res.result) throw new Error(res.message ?? t("toastAddError"))
          setSelected("")
          router.refresh()
          return t("toastAdded")
        },
        error: (e: unknown) => (e instanceof Error ? e.message : t("toastAddError")),
      })
      await p.catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  async function onLevel(userId: string, newLevel: Level) {
    await toast.promise(updateProjectMemberLevel({ projectId, userId, level: newLevel }), {
      loading: t("toastUpdating"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("toastUpdateError"))
        router.refresh()
        return t("toastUpdated")
      },
      error: (e: unknown) => (e instanceof Error ? e.message : t("toastUpdateError")),
    })
  }

  async function onRemove(m: MemberRow) {
    const ok = await confirm({
      title: t("removeConfirmTitle"),
      description: t("removeConfirmBody"),
      destructive: true,
    })
    if (!ok) return
    await toast.promise(removeProjectMember({ projectId, userId: m.userId }), {
      loading: t("toastRemoving"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("toastRemoveError"))
        router.refresh()
        return t("toastRemoved")
      },
      error: (e: unknown) => (e instanceof Error ? e.message : t("toastRemoveError")),
    })
  }

  async function onBan(m: MemberRow) {
    // Ban is destructive (revokes connections, kills tokens): confirm required.
    const ok = await confirm({
      title: t("banConfirmTitle"),
      description: t("banConfirmBody"),
      destructive: true,
    })
    if (!ok) return
    await toast.promise(banProjectMember({ projectId, userId: m.userId, scope: "project" }), {
      loading: t("toastBanning"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("toastBanError"))
        router.refresh()
        return t("toastBanned")
      },
      error: (e: unknown) => (e instanceof Error ? e.message : t("toastBanError")),
    })
  }

  async function onUnban(m: MemberRow) {
    // Unban is non-destructive: no confirm dialog.
    await toast.promise(unbanProjectMember({ projectId, userId: m.userId, scope: "project" }), {
      loading: t("toastUnbanning"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("toastUnbanError"))
        router.refresh()
        return t("toastUnbanned")
      },
      error: (e: unknown) => (e instanceof Error ? e.message : t("toastUnbanError")),
    })
  }

  return (
    <div className="space-y-4">
      {confirmDialog}

      {/* Add member (owners / org admins only) */}
      {canManage && (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        {addable.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("allAdded")}</p>
        ) : (
          <>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className={`${selectCls} min-w-0 flex-1`}
              aria-label={t("addPlaceholder")}
            >
              <option value="">{t("addPlaceholder")}</option>
              {addable.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} ({m.email})
                </option>
              ))}
            </select>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as Level)}
              className={selectCls}
              aria-label={t("levelLabel")}
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>{levelLabel[l]}</option>
              ))}
            </select>
            <Button size="sm" onClick={onAdd} disabled={!selected || busy}>
              <UserPlusIcon className="mr-1.5 h-4 w-4" />
              {t("add")}
            </Button>
          </>
        )}
      </div>
      )}

      {/* Member list */}
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {members.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">{t("empty")}</li>
        ) : (
          members.map((m) => {
            // A project must keep at least one owner: lock the last owner's row.
            const lastOwner = normalizeLevel(m.level) === "owner" && ownerCount <= 1
            const banned = !!m.bannedAt
            return (
              <li key={m.userId} className="flex items-center gap-3 px-4 py-3">
                <Avatar size="sm">
                  <AvatarFallback>{initials(m.name)}</AvatarFallback>
                </Avatar>
                <div className={`min-w-0 flex-1 ${banned ? "opacity-50" : ""}`}>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{m.name}</span>
                    {m.isCreator && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {t("creator")}
                      </span>
                    )}
                    {banned && (
                      <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                        {t("bannedBadge")}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                </div>
                {canManage ? (
                  <>
                    <select
                      value={normalizeLevel(m.level)}
                      onChange={(e) => onLevel(m.userId, e.target.value as Level)}
                      disabled={lastOwner || banned}
                      title={lastOwner ? t("lastOwnerHint") : undefined}
                      className={selectCls}
                      aria-label={t("levelLabel")}
                    >
                      {LEVELS.map((l) => (
                        <option key={l} value={l}>{levelLabel[l]}</option>
                      ))}
                    </select>
                    {banned ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onUnban(m)}
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                        aria-label={t("unban")}
                        title={t("unban")}
                      >
                        <RotateCcwIcon className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onBan(m)}
                        disabled={lastOwner}
                        title={lastOwner ? t("lastOwnerBanHint") : t("ban")}
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                        aria-label={t("ban")}
                      >
                        <BanIcon className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onRemove(m)}
                      disabled={lastOwner}
                      title={lastOwner ? t("lastOwnerHint") : undefined}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      aria-label={t("remove")}
                    >
                      <Trash2Icon className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {levelLabel[normalizeLevel(m.level)]}
                  </span>
                )}
              </li>
            )
          })
        )}
      </ul>
    </div>
  )
}
