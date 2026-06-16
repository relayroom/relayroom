import { requireDashboardAccess } from "@/lib/auth-session"
import { getTranslations } from "next-intl/server"
import { ProfileForm } from "@/components/settings/profile-form"
import { ChangePasswordForm } from "@/components/settings/change-password-form"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

export default async function SettingsProfilePage() {
  const session = await requireDashboardAccess()
  const tProfile = await getTranslations("my.profile")
  const tPassword = await getTranslations("my.password")

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      {/* Account info card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tProfile("accountInfo.title")}</CardTitle>
          <CardDescription>{tProfile("accountInfo.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {tProfile("accountInfo.emailLabel")}
            </p>
            <div className="flex items-center gap-2">
              <p className="text-sm font-mono">{session.user.email}</p>
              <Badge variant="secondary" className="text-xs">{tProfile("accountInfo.readOnly")}</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Editable profile + password: side by side on desktop, stacked on tablet */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tProfile("editName.title")}</CardTitle>
            <CardDescription>{tProfile("editName.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileForm
              initialName={session.user.name ?? ""}
              initialNickname={(session.user as { nickname?: string | null }).nickname ?? ""}
              email={session.user.email ?? ""}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tPassword("cardTitle")}</CardTitle>
            <CardDescription>{tPassword("cardDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
