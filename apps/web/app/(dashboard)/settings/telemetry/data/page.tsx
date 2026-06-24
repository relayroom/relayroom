import Link from "next/link"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { CheckIcon, XIcon, ArrowLeftIcon } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { isInstanceSuperuser } from "@/modules/admin/queries"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"

export const dynamic = "force-dynamic"

// Keys for the lists rendered from the `telemetry.data` namespace. Kept here so
// the page stays a thin renderer and all copy lives in the message JSON.
const COLLECTED_KEYS = [
  "version",
  "edition",
  "os",
  "uptimeBucket",
  "scaleBucket",
  "messageCountBucket",
  "tokenBucket",
  "providerFamily",
  "wakeLoopCount",
] as const

const NEVER_KEYS = [
  "messageBodies",
  "prompts",
  "responses",
  "names",
  "tokenValues",
] as const

export default async function TelemetryDataPage() {
  const session = await requireDashboardAccess()

  const isSuper = await isInstanceSuperuser(session.user.id)
  if (!isSuper) redirect("/settings/profile")

  const t = await getTranslations("telemetry.data")

  return (
    <div className="py-6 px-4 xs:px-6 max-w-3xl mx-auto space-y-6">
      <Link
        href="/settings/telemetry"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeftIcon className="h-3.5 w-3.5" />
        {t("back")}
      </Link>

      <div className="space-y-1">
        <h1 className="text-xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      {/* "Never collected" first - leads with the privacy reassurance before the list of what IS sent. */}
      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-base">{t("never.title")}</CardTitle>
          <CardDescription>{t("never.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {NEVER_KEYS.map((key) => (
              <li key={key} className="flex items-center gap-2.5">
                <XIcon className="h-4 w-4 shrink-0 text-destructive" />
                <span className="text-sm">{t(`never.items.${key}`)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("collected.title")}</CardTitle>
          <CardDescription>{t("collected.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {COLLECTED_KEYS.map((key) => (
              <li key={key} className="flex items-start gap-2.5">
                <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t(`collected.items.${key}.label`)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`collected.items.${key}.detail`)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("optOut.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">{t("optOut.body")}</p>
          <Link
            href="/settings/telemetry"
            className="inline-block text-sm underline underline-offset-2 hover:text-foreground"
          >
            {t("optOut.link")}
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
