import { redirect } from "next/navigation"

/**
 * Legacy route: /settings/team has been migrated to /organizations.
 * Redirect permanently so bookmarks / external links still work.
 */
export default function LegacyTeamSettingsPage() {
  redirect("/organizations")
}
