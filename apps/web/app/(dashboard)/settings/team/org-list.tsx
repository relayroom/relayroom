"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

type Org = {
  id: string
  name: string
  slug: string | null
}

type OrgListProps = {
  orgs: Org[]
  activeOrgId: string | null
}

export function OrgList({ orgs, activeOrgId }: OrgListProps) {
  const router = useRouter()
  const t = useTranslations("team.orgList")
  const [pendingId, setPendingId] = useState<string | null>(null)

  async function handleSetActive(orgId: string) {
    setPendingId(orgId)
    try {
      const result = await authClient.organization.setActive({ organizationId: orgId })
      if (result.error) {
        toast.error(result.error.message ?? t("setActiveError"))
        return
      }
      toast.success(t("setActiveSuccess"))
      router.refresh()
    } catch {
      toast.error(t("setActiveError"))
    } finally {
      setPendingId(null)
    }
  }

  if (orgs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("descriptionEmpty")}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {orgs.map((org) => (
            <li
              key={org.id}
              className="flex items-center justify-between gap-3 rounded-md border px-4 py-3"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium truncate">{org.name}</span>
                {org.slug && (
                  <span className="text-xs text-muted-foreground font-mono">/{org.slug}</span>
                )}
                {org.id === activeOrgId && (
                  <Badge variant="secondary" className="text-xs">{t("activeBadge")}</Badge>
                )}
              </div>
              {org.id !== activeOrgId && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pendingId !== null}
                  onClick={() => handleSetActive(org.id)}
                >
                  {pendingId === org.id ? t("settingActive") : t("setActiveButton")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
