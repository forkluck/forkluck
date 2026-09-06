import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { SignupForm } from "@/components/auth/signup-form"
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
  const session = await getSession()
  if (session) redirect(next)

  return <SignupForm next={next} />
}
