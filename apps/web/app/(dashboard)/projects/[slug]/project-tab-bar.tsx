"use client"

import { useTranslations } from "next-intl"
import { TabBar, type TabItem } from "@/components/layouts/app/tab-bar"

interface Props {
  slug: string
}

export function ProjectTabBar({ slug }: Props) {
  const t = useTranslations("project")
  const base = `/projects/${slug}`

  const tabs: TabItem[] = [
    { label: t("tabs.overview"), href: base, exact: true },
    { label: t("tabs.threads"), href: `${base}/threads` },
    { label: t("tabs.events"), href: `${base}/events` },
    { label: t("tabs.agents"), href: `${base}/agents` },
    { label: t("tabs.members"), href: `${base}/members` },
    { label: t("tabs.usage"), href: `${base}/usage` },
    { label: t("tabs.settings"), href: `${base}/settings` },
  ]

  return <TabBar tabs={tabs} ariaLabel={t("tabs.ariaLabel")} />
}
