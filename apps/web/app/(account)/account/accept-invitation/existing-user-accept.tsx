"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { authClient } from "@/lib/auth-client"
import { signOutAction } from "@/app/(account)/account/sign-out/actions"
import { Button } from "@/components/ui/button"

interface Props {
  invitationId: string
  sessionEmail: string
  invitedEmail: string
  orgName: string
}

export function ExistingUserAccept({
  invitationId,
  sessionEmail,
  invitedEmail,
  orgName,
}: Props) {
  const router = useRouter()
  const t = useTranslations("auth.acceptInvitation.existingUser")
  const [pending, setPending] = useState(false)

  const emailMismatch =
    sessionEmail.toLowerCase() !== invitedEmail.toLowerCase()

  async function handleAccept() {
    setPending(true)
    toast.promise(
      (async () => {
        const { error } = await authClient.organization.acceptInvitation({
          invitationId,
        })
        if (error) throw new Error(error.message || t("toastError"))
        router.push("/")
        router.refresh()
      })(),
      {
        loading: t("toastLoading"),
        success: t("toastSuccess", { orgName }),
        error: (err: Error) => err.message ?? t("toastError"),
        finally: () => setPending(false),
      },
    )
  }

  if (emailMismatch) {
    // After logout, return to the sign-in page with this invite preserved as
    // redirectTo so the correct account lands back here and can accept.
    const postLogout = `/account/sign-in?redirectTo=${encodeURIComponent(
      `/account/accept-invitation?id=${invitationId}`,
    )}`
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">
          {t("mismatchError", { sessionEmail, invitedEmail })}
        </p>
        <form action={signOutAction}>
          <input type="hidden" name="redirectTo" value={postLogout} />
          <Button type="submit" variant="outline" className="w-full">
            {t("logoutButton")}
          </Button>
        </form>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("loggedInAs", { email: sessionEmail, orgName })}
      </p>
      <Button onClick={handleAccept} disabled={pending} className="w-full">
        {pending ? t("joinPending") : t("joinButton", { orgName })}
      </Button>
    </div>
  )
}
