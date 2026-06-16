import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { requireDashboardAccess } from "@/lib/auth-session"
import { isInstanceSuperuser, getSmtpConfig } from "@/modules/admin/queries"
import { SmtpForm } from "@/components/settings/smtp-form"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function SettingsSmtpPage() {
  const session = await requireDashboardAccess()

  // SMTP config is instance-wide and only the superuser (earliest-created user,
  // the installer) may view or change it. Everyone else is bounced to profile.
  const isSuper = await isInstanceSuperuser(session.user.id)
  if (!isSuper) redirect("/settings/profile")

  const t = await getTranslations("admin.smtp")
  const config = await getSmtpConfig()

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("cardTitle")}</CardTitle>
          <CardDescription>{t("cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <SmtpForm initial={config} testEmail={session.user.email ?? ""} />
        </CardContent>
      </Card>
    </div>
  )
}
