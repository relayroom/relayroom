import { getTranslations } from "next-intl/server"
import { signOutAction } from "../sign-out/actions"

export async function generateMetadata() {
  const t = await getTranslations("auth.pending")
  return { title: t("pageTitle") }
}

export default async function PendingPage() {
  const t = await getTranslations("auth.pending")
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("message")}
        </p>
        <form action={signOutAction}>
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-lg border border-transparent bg-primary text-primary-foreground text-sm font-medium h-8 px-4 transition-all hover:bg-primary/80"
          >
            {t("signOutButton")}
          </button>
        </form>
      </div>
    </div>
  )
}
