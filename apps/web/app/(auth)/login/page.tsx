import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { authNoticeCode } from "@/components/auth/auth-notice"
import { LoginForm } from "@/components/auth/login-form"
import { getAuthMethods } from "@/lib/backend/queries"
import { getSession } from "@/lib/auth-session"
import { safeAuthNext } from "@/lib/auth-next"

export const metadata: Metadata = {
  title: "Sign in",
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string | string[]
    reauth?: string
    error?: string | string[]
  }>
}) {
  const params = await searchParams
  const next = safeAuthNext(params.next)
  const [session, methods] = await Promise.all([getSession(), getAuthMethods()])
  const errorCode = authNoticeCode(params.error)
  if (session && params.reauth !== "1" && !errorCode) redirect(next)

  return (
    <LoginForm
      next={next}
      googleEnabled={methods.google}
      errorCode={errorCode}
    />
  )
}
