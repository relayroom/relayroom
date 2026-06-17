import { requireDashboardAccess } from "@/lib/auth-session"
import { getTranslations } from "next-intl/server"
import { LanguageSwitcher } from "@/components/language-switcher"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function SettingsLanguagesPage() {
  await requireDashboardAccess()
  const t = await getTranslations("settings")

  return (
    <div className="w-full py-6 px-4 xs:px-6 max-w-6xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("language.title")}</CardTitle>
          <CardDescription>{t("language.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <LanguageSwitcher />
        </CardContent>
      </Card>
    </div>
  )
}
