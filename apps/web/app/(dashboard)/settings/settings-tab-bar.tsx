"use client"

import { useTranslations } from "next-intl"
import { TabBar, type TabItem } from "@/components/layouts/app/tab-bar"

interface SettingsTabBarProps {
  /** Show the Environments tab. Superuser only (instance-wide deployment config). */
  showEnvironments?: boolean
  /** Show the Mail tab. Only the instance superuser may see/edit mail config. */
  showSmtp?: boolean
  /** Show the Telemetry tab. Only the instance superuser may see/change it. */
  showTelemetry?: boolean
}

export function SettingsTabBar({
  showEnvironments = false,
  showSmtp = false,
  showTelemetry = false,
}: SettingsTabBarProps) {
  const t = useTranslations("settings")
  const tAdmin = useTranslations("admin")
  const tTelemetry = useTranslations("telemetry")
  const tEnv = useTranslations("environments")
  const tUpdates = useTranslations("updates")
  const tFeedback = useTranslations("feedback")

  const tabs: TabItem[] = [
    // "/settings" (index) redirects to profile, so it counts as the profile tab.
    { label: t("nav.profile"), href: "/settings/profile", aliases: ["/settings"] },
    { label: t("nav.themes"), href: "/settings/themes" },
    { label: t("nav.languages"), href: "/settings/languages" },
    ...(showEnvironments ? [{ label: tEnv("nav.tab"), href: "/settings/environments" }] : []),
    ...(showSmtp ? [{ label: tAdmin("nav.smtp"), href: "/settings/mail" }] : []),
    ...(showTelemetry
      ? [
          {
            label: tTelemetry("nav.tab"),
            href: "/settings/telemetry",
            aliases: ["/settings/telemetry/data"],
          },
        ]
      : []),
    { label: tUpdates("nav.tab"), href: "/settings/updates" },
    { label: tFeedback("nav.tab"), href: "/settings/feedback" },
  ]

  return <TabBar tabs={tabs} ariaLabel={t("nav.ariaLabel")} />
}
