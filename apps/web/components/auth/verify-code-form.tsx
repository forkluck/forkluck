"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { writeLastSignInMethod } from "@/components/auth/last-sign-in-method"
import { Button } from "@/components/ui/button"
import { LabeledInput } from "@/components/ui/labeled-field"
import {
  authHeadingClassName,
  authLinkClassName,
  authSubtitleClassName,
} from "@/components/auth/auth-styles"
import { authClient } from "@/lib/auth-client"
import { cn } from "@/lib/utils"
import { useRefresh } from "@/hooks/use-refresh"

/** The 6-digit step shared by signup and sign-in for unverified accounts. */
export function VerifyCodeForm({
  email,
  next = "/",
}: {
  email: string
  /** Where verifying lands, carried through from sign-in. */
  next?: string
}) {
  const router = useRouter()
  const { refresh } = useRefresh()
  const [code, setCode] = React.useState("")
  const [verifyError, setVerifyError] = React.useState<string | null>(null)
  const [resendError, setResendError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [resent, setResent] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setVerifyError(null)
    setResendError(null)
    if (code.length !== 6) {
      setVerifyError("Enter the 6-digit code.")
      return
    }
    setPending(true)
    const result = await authClient.verifyEmail({ email, code })
    if (result.error || !result.data) {
      setVerifyError(
        result.error?.message ?? "That code didn't work — try again."
      )
      setPending(false)
      return
    }
    writeLastSignInMethod("password")
    if (next.startsWith("/api/")) {
      window.location.assign(next)
      return
    }
    router.push(next)
    void refresh()
  }

  const resend = async () => {
    setVerifyError(null)
    setResendError(null)
    setResent(false)
    const result = await authClient.resendCode({ email })
    if (result.error) {
      setResendError(result.error.message)
      return
    }
    setResent(true)
  }

  return (
    <form onSubmit={submit} className="flex flex-col">
      <h1 className={authHeadingClassName}>Check your email</h1>
      <p className={authSubtitleClassName}>
        We sent a 6-digit code to {email}. Enter it to finish signing in.
      </p>

      <LabeledInput
        label="Code"
        id="verify-code"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        autoComplete="one-time-code"
        autoFocus
        value={code}
        onChange={(e) => {
          setCode(e.target.value.replace(/\D/g, ""))
          setVerifyError(null)
        }}
        aria-invalid={Boolean(verifyError)}
        className="tracking-[0.24em] tabular-nums"
        containerClassName="mt-6"
      />
      {verifyError ? (
        <p role="alert" className="mt-4 text-md leading-5 text-destructive">
          {verifyError}
        </p>
      ) : null}
      {resendError ? (
        <p role="alert" className="mt-4 text-md leading-5 text-destructive">
          {resendError}
        </p>
      ) : null}
      {resent ? (
        <p
          role="status"
          className="mt-4 text-md leading-5 text-muted-foreground"
        >
          A new code is on its way.
        </p>
      ) : null}
      <Button type="submit" size="lg" pending={pending} className="mt-6">
        Verify
      </Button>
      <button
        type="button"
        onClick={resend}
        className={cn("mt-6 self-center text-sm leading-5", authLinkClassName)}
      >
        Resend code
      </button>
    </form>
  )
}
