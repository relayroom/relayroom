"use client"
import { createAuthClient } from "better-auth/react"
import { organizationClient, inferAdditionalFields } from "better-auth/client/plugins"
import type { auth } from "./auth"

function baseURL() {
  if (typeof window !== "undefined") return window.location.origin
  return process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:48800"
}

export const authClient = createAuthClient({
  baseURL: baseURL(),
  // inferAdditionalFields<typeof auth> is type-only (the `import type` above is
  // erased at runtime), so the server module is never bundled into the client.
  plugins: [organizationClient(), inferAdditionalFields<typeof auth>()],
})
export const { signIn, signOut, signUp, useSession } = authClient
