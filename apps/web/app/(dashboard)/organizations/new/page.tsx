import { getTranslations } from "next-intl/server"
import { requireDashboardAccess } from "@/lib/auth-session"
import { CreateOrganizationForm } from "./create-organization-form"

export const dynamic = "force-dynamic"

export default async function NewOrganizationPage() {
  const [, t] = await Promise.all([
    requireDashboardAccess(),
    getTranslations("org"),
  ])

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
