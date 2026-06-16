"use client";

import Link from "next/link";
import { useSession } from "@/lib/auth-client";

/**
 * Auth-aware nav slot: shows "Dashboard" when signed in, "Sign in" otherwise.
 * Client-side so the shared SiteNav stays statically generable (docs uses SSG);
 * the session resolves on the client and the link updates. Keeps the landing,
 * docs, and app nav consistent about login state.
 */
export function SiteNavAuth({ locale }: { locale: "en" | "ko" }) {
  const { data: session } = useSession();
  const authed = !!session;
  const className =
    "hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:block";

  return authed ? (
    <Link href="/dashboard" className={className}>
      {locale === "ko" ? "대시보드" : "Dashboard"}
    </Link>
  ) : (
    <Link href="/account/sign-in" className={className}>
      {locale === "ko" ? "로그인" : "Sign in"}
    </Link>
  );
}
