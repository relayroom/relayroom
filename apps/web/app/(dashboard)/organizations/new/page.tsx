import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { requireDashboardAccess, getOrganizations } from "@/lib/auth-session"
import { CreateOrganizationForm } from "./create-organization-form"

export const dynamic = "force-dynamic"

export default async function NewOrganizationPage() {
  const [, orgs, t] = await Promise.all([
    requireDashboardAccess(),
    getOrganizations(),
    getTranslations("org"),
  ])

  // Community Edition is single-workspace: once an organization exists, there is
  // no creating a second one. Send people back instead of a form that would fail.
  if (orgs.length > 0) redirect("/dashboard")

  return (
    <div className="py-6 px-4 xs:px-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("new.pageTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("new.pageDescription")}
        </p>
      </div>
      <CreateOrganizationForm />
    </div>
  )
}
