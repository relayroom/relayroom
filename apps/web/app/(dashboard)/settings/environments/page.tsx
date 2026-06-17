import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { requireDashboardAccess } from "@/lib/auth-session"
import { isInstanceSuperuser, getServerBaseConfig } from "@/modules/admin/queries"
import { getEnvServerBase } from "@/lib/server-base"
import { EnvironmentsForm } from "@/components/settings/environments-form"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function SettingsEnvironmentsPage() {
  const session = await requireDashboardAccess()

  // Instance-wide deployment settings: superuser (the installer) only.
  const isSuper = await isInstanceSuperuser(session.user.id)
  if (!isSuper) redirect("/settings/profile")

  const t = await getTranslations("environments")
  const initialServerBase = (await getServerBaseConfig()) ?? ""
  const envServerBase = getEnvServerBase()
  const publicWebUrl =
    process.env.RELAYROOM_PUBLIC_WEB_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:48800"

  return (
    <div className="w-full py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("cardTitle")}</CardTitle>
          <CardDescription>{t("cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <EnvironmentsForm
            initialServerBase={initialServerBase}
            envServerBase={envServerBase}
            publicWebUrl={publicWebUrl}
          />
        </CardContent>
      </Card>
    </div>
  )
}
