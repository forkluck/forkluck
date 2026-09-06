import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form"
import { getSession } from "@/lib/auth-session"

export const metadata: Metadata = {
  title: "Reset password",
}

export default async function ForgotPasswordPage() {
  const session = await getSession()
  if (session) redirect("/")

  return <ForgotPasswordForm />
}
