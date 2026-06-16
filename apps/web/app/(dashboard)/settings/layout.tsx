import type { ReactNode } from "react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { isInstanceSuperuser } from "@/modules/admin/queries"
import { StickyTabHeader } from "@/components/layouts/app/sticky-tab-header"
import { SettingsTabBar } from "./settings-tab-bar"

export const dynamic = "force-dynamic"

interface Props {
  children: ReactNode
}

export default async function SettingsLayout({ children }: Props) {
  const session = await requireDashboardAccess()
  // Both Mail and Telemetry are instance-wide settings, gated to the superuser.
  const isSuper = await isInstanceSuperuser(session.user.id)
  const showSmtp = isSuper
  const showTelemetry = isSuper

  // Same window-scroll + sticky-header model as the project layout, so the tab
  // bar (overflow scroll, alignment, scroll shadow) behaves identically.
  return (
    <div className="flex flex-col">
      <StickyTabHeader>
        <SettingsTabBar showSmtp={showSmtp} showTelemetry={showTelemetry} />
      </StickyTabHeader>
      {children}
    </div>
  )
}
