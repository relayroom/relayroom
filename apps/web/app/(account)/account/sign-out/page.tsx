import { getTranslations } from "next-intl/server"
import { signOutAction } from "./actions"

export default async function SignOutPage() {
  const t = await getTranslations("auth.signOut")
  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <div className="text-center space-y-4">
        <p className="text-sm text-muted-foreground">{t("confirmMessage")}</p>
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
