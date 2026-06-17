import { getTranslations } from "next-intl/server"
import { requireDashboardAccess } from "@/lib/auth-session"
import { FeedbackForm } from "@/components/settings/feedback-form"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"

export const dynamic = "force-dynamic"

// Feedback is the user's own message, not an instance config change, so it is
// open to any signed-in dashboard user (unlike the superuser-gated tabs).
export default async function SettingsFeedbackPage() {
  await requireDashboardAccess()
  const t = await getTranslations("feedback.settings")

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("cardTitle")}</CardTitle>
          <CardDescription>{t("cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FeedbackForm />
        </CardContent>
      </Card>
    </div>
  )
}
