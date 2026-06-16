import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { requireDashboardAccess } from "@/lib/auth-session"
import { isInstanceSuperuser } from "@/modules/admin/queries"
import type { Db } from "@relayroom/db/client"
import { getMode } from "@relayroom/telemetry"
import { db as rawDb } from "@/modules/drizzle/db"
import { TelemetryForm } from "@/components/settings/telemetry-form"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function SettingsTelemetryPage() {
  const session = await requireDashboardAccess()

  // Telemetry consent is an instance-wide decision, so only the superuser
  // (earliest-created user, the installer) may view or change it. Everyone else
  // is bounced to profile, matching the SMTP settings page.
  const isSuper = await isInstanceSuperuser(session.user.id)
  if (!isSuper) redirect("/settings/profile")

  const t = await getTranslations("telemetry.settings")
  // Bridge the node-postgres (web) vs postgres-js (@relayroom/db) driver types;
  // getMode only reads the `configurations` table, so this is runtime-safe.
  const mode = await getMode(rawDb as unknown as Db)

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("cardTitle")}</CardTitle>
          <CardDescription>{t("cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <TelemetryForm initialMode={mode} />
        </CardContent>
      </Card>
    </div>
  )
}
