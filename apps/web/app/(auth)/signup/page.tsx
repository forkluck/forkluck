import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { SignupForm } from "@/components/auth/signup-form"
import { getAuthMethods } from "@/lib/backend/queries"
import { getSession } from "@/lib/auth-session"
import { safeAuthNext } from "@/lib/auth-next"

export const metadata: Metadata = {
  title: "Create account",
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  const next = safeAuthNext((await searchParams).next)
  const [session, methods] = await Promise.all([getSession(), getAuthMethods()])
  if (session) redirect(next)

  return (
    <SignupForm
      next={next}
      googleEnabled={methods.google}
      turnstileSiteKey={methods.turnstileSiteKey}
    />
  )
}
