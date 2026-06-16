"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Copy, X } from "lucide-react"

type Invitation = {
  id: string
  email: string
  role: string | null
  status: string
  expiresAt: Date | string
}

interface Props {
  invitations: Invitation[]
}

export function PendingInvitations({ invitations }: Props) {
  const router = useRouter()
  const t = useTranslations("org")
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  async function handleCopy(invitationId: string) {
    const url = `${window.location.origin}/account/accept-invitation?id=${invitationId}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t("pending.copySuccess"))
    } catch {
      toast.error(t("pending.copyError"))
    }
  }

  async function handleCancel(invitationId: string) {
    setCancellingId(invitationId)
    try {
      const result = await authClient.organization.cancelInvitation({ invitationId })
      if (result.error) {
        toast.error(result.error.message ?? t("pending.cancelError"))
        return
      }
      toast.success(t("pending.cancelSuccess"))
      router.refresh()
    } catch {
      toast.error(t("pending.cancelError"))
    } finally {
      setCancellingId(null)
    }
  }

  if (invitations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t("pending.empty")}</p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("pending.tableEmail")}</TableHead>
          <TableHead>{t("pending.tableRole")}</TableHead>
          <TableHead>{t("pending.tableStatus")}</TableHead>
          <TableHead>{t("pending.tableExpires")}</TableHead>
          <TableHead className="text-right">{t("pending.tableActions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invitations.map((inv) => (
          <TableRow key={inv.id}>
            <TableCell className="font-mono text-sm">{inv.email}</TableCell>
            <TableCell>
              <Badge variant="outline">{inv.role ?? "member"}</Badge>
            </TableCell>
            <TableCell>
              <Badge variant="secondary">{inv.status}</Badge>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {new Date(inv.expiresAt).toLocaleDateString()}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleCopy(inv.id)}
                  title={t("pending.copyTitle")}
                >
                  <Copy className="h-3.5 w-3.5 mr-1" />
                  {t("pending.copyButton")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cancellingId !== null}
                  onClick={() => handleCancel(inv.id)}
                  title={t("pending.cancelTitle")}
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  {t("pending.cancelButton")}
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
