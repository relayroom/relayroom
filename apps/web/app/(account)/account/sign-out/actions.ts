"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { safeRedirect } from "@/lib/redirect"
import { SIGN_IN_PATH } from "@/constants/service"

/**
 * Sign the current user out and redirect.
 *
 * Backward-compatible: called with no args (or a FormData lacking `redirectTo`)
 * it redirects to the sign-in page as before. When used as a `<form action>`, an
 * optional hidden `redirectTo` input lets callers preserve context (e.g. a pending
 * invite) by sending the user to the sign-in page with a `redirectTo` of their own.
 * The value is sanitized via safeRedirect to block open-redirect.
 */
export async function signOutAction(formData?: FormData) {
  await auth.api.signOut({ headers: await headers() })

  const raw = formData?.get("redirectTo")
  const target =
    typeof raw === "string" && raw.length > 0 ? safeRedirect(raw) : SIGN_IN_PATH
  redirect(target)
}
