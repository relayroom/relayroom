import { getTranslations, getLocale } from "next-intl/server"
import { ArrowUpCircle, CheckCircle2 } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { isInstanceSuperuser } from "@/modules/admin/queries"
import { getVersionInfo } from "@/lib/version"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"

export const dynamic = "force-dynamic"

const RELEASES_URL = "https://github.com/relayroom/relayroom/releases/latest"

export default async function SettingsUpdatesPage() {
  const session = await requireDashboardAccess()
  const [isSuper, version, t, locale] = await Promise.all([
    isInstanceSuperuser(session.user.id),
    getVersionInfo(),
    getTranslations("updates"),
    getLocale(),
  ])
  const upgradeDocsUrl = `https://relayroom.dev/docs/${locale}/updating`

  return (
    <div className="w-full py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("cardTitle")}</CardTitle>
          <CardDescription>{t("cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-muted-foreground">{t("currentVersion")}</span>
            <span className="font-mono text-lg font-semibold">v{version.current}</span>
          </div>

          {version.updateAvailable && version.latest ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
              <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-500">
                <ArrowUpCircle className="h-4 w-4 shrink-0" />
                {t("updateAvailable", { version: version.latest })}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {isSuper ? t("superuserGuidance") : t("memberGuidance")}
              </p>
              {isSuper && (
                <div className="mt-3 flex flex-wrap gap-3 text-sm">
                  <a
                    href={upgradeDocsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-foreground underline hover:no-underline"
                  >
                    {t("howToUpdate")}
                  </a>
                  <a
                    href={RELEASES_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground underline hover:text-foreground hover:no-underline"
                  >
                    {t("releaseNotes")}
                  </a>
                </div>
              )}
            </div>
          ) : version.latest ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
              {t("upToDate")}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">{t("checkUnavailable")}</div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
