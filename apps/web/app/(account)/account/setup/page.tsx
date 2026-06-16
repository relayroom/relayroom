import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { adminExists } from "@/lib/auth-session"
import { SIGN_IN_PATH } from "@/constants/service"
import { SetupForm } from "./setup-form"

// Queries the DB (adminExists) without touching cookies/headers, so Next would
// otherwise try to statically prerender this at build time and fail with
// ECONNREFUSED (no DB in the build stage). Force dynamic rendering.
export const dynamic = "force-dynamic"

export async function generateMetadata() {
  const t = await getTranslations("auth.setup")
  return { title: t("pageTitle") }
}

export default async function SetupPage() {
  // Gate on admin existence, not user count: setup stays open until an admin exists,
  // giving a recovery path for a stranded users-but-no-admin install.
  if (await adminExists()) {
    redirect(SIGN_IN_PATH)
  }

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-full max-w-sm">
        <SetupForm />
      </div>
    </div>
  )
}
