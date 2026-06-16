import { requireDashboardAccess } from "@/lib/auth-session"
import { ThemeCard } from "@/components/settings/theme-card"

export const dynamic = "force-dynamic"

export default async function SettingsThemesPage() {
  await requireDashboardAccess()

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto">
      <ThemeCard />
    </div>
  )
}
