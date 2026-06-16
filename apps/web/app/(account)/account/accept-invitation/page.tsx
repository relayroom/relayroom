import Link from "next/link"
import { eq } from "drizzle-orm"
import { getTranslations } from "next-intl/server"
import { db } from "@/lib/db"
import {
  better_auth_invitation,
  better_auth_organization,
  better_auth_user,
} from "@relayroom/db/auth-schema"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AcceptForm } from "./accept-form"
import { getServerSession } from "@/lib/auth-session"
import { ExistingUserAccept } from "./existing-user-accept"

export const dynamic = "force-dynamic"

export async function generateMetadata() {
  const t = await getTranslations("auth.acceptInvitation")
  return { title: t("pageTitle") }
}

interface Props {
  searchParams: Promise<{ id?: string }>
}

export default async function AcceptInvitationPage({ searchParams }: Props) {
  const t = await getTranslations("auth.acceptInvitation")
  const { id } = await searchParams

  if (!id) {
    return <ErrorCard message={t("error.invalidLink")} />
  }

  // Fetch invitation + org name directly from DB (getInvitation API requires a matching session)
  const rows = await db
    .select({
      id: better_auth_invitation.id,
      email: better_auth_invitation.email,
      role: better_auth_invitation.role,
      status: better_auth_invitation.status,
      expiresAt: better_auth_invitation.expiresAt,
      orgName: better_auth_organization.name,
    })
    .from(better_auth_invitation)
    .leftJoin(
      better_auth_organization,
      eq(better_auth_invitation.organizationId, better_auth_organization.id),
    )
    .where(eq(better_auth_invitation.id, id))

  const invitation = rows[0]

  if (!invitation) {
    return <ErrorCard message={t("error.notFound")} />
  }
  if (invitation.status !== "pending") {
    return <ErrorCard message={t("error.alreadyUsed")} />
  }
  if (invitation.expiresAt < new Date()) {
    return <ErrorCard message={t("error.expired")} />
  }

  const orgName = invitation.orgName ?? t("orgNameFallback")

  // Check if there's an existing session
  const session = await getServerSession()

  // Does the invited email already have an account? (read-only)
  // Determines the logged-out branch: new-account form vs. sign-in panel.
  let invitedEmailHasAccount = false
  if (!session) {
    const existing = await db
      .select({ id: better_auth_user.id })
      .from(better_auth_user)
      .where(eq(better_auth_user.email, invitation.email))
    invitedEmailHasAccount = existing.length > 0
  }

  // Preserve the invite across sign-in so they round-trip back here with a session.
  const signInHref = `/account/sign-in?redirectTo=${encodeURIComponent(
    `/account/accept-invitation?id=${id}`,
  )}`

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>{t("cardTitle")}</CardTitle>
            <CardDescription>
              <strong>{orgName}</strong>{" "}
              {t("cardDescription", { orgName })}
              <br />
              {t("invitedEmail", { email: invitation.email })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {session ? (
              <ExistingUserAccept
                invitationId={invitation.id}
                sessionEmail={session.user.email}
                invitedEmail={invitation.email}
                orgName={orgName}
              />
            ) : invitedEmailHasAccount ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t("hasAccountText")}
                </p>
                <Button render={<Link href={signInHref} />} className="w-full">
                  {t("signInToAccept")}
                </Button>
              </div>
            ) : (
              <AcceptForm
                invitationId={invitation.id}
                email={invitation.email}
                orgName={orgName}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

async function ErrorCard({ message }: { message: string }) {
  const t = await getTranslations("auth.acceptInvitation.error")
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>{t("cardTitle")}</CardTitle>
            <CardDescription>{message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    </div>
  )
}
