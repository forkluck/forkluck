import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { LoginForm } from "@/components/auth/login-form"
import { getSession } from "@/lib/auth-session"
import { safeAuthNext } from "@/lib/auth-next"

export const metadata: Metadata = {
  title: "Sign in",
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; reauth?: string }>
}) {
  const params = await searchParams
  const next = safeAuthNext(params.next)
  const session = await getSession()
  if (session && params.reauth !== "1") redirect(next)

  return <LoginForm next={next} />
}
