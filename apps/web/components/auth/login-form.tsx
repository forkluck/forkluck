"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { AuthMethodsSeparator } from "@/components/auth/auth-methods-separator"
import { GoogleButton } from "@/components/auth/google-button"
import { authNotice, type AuthNoticeCode } from "@/components/auth/auth-notice"
import {
  useLastSignInMethod,
  writeLastSignInMethod,
} from "@/components/auth/last-sign-in-method"
import { Button } from "@/components/ui/button"
import { LabeledInput } from "@/components/ui/labeled-field"
import {
  authHeadingClassName,
  authLinkClassName,
  authSwitchClassName,
} from "@/components/auth/auth-styles"
import { PasswordToggle } from "@/components/auth/password-toggle"
import { VerifyCodeForm } from "@/components/auth/verify-code-form"
import { authClient } from "@/lib/auth-client"
import { useRefresh } from "@/hooks/use-refresh"

/** `next` is where signing in lands, so a recipe invite reaches its recipe. */
export function LoginForm({
  next = "/",
  googleEnabled = false,
  errorCode,
}: {
  next?: string
  googleEnabled?: boolean
  errorCode?: AuthNoticeCode
}) {
  const lastMethod = useLastSignInMethod()
  const notice = errorCode ? authNotice[errorCode] : undefined
  const router = useRouter()
  const { refresh } = useRefresh()
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [passwordVisible, setPasswordVisible] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [awaitingCode, setAwaitingCode] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!email.trim()) {
      setError("Enter your email.")
      return
    }
    if (!password) {
      setError("Enter your password.")
      return
    }
    setPending(true)
    const result = await authClient.signIn.email({ email, password })
    if (result.pendingVerification) {
      // The account exists but the address was never confirmed; a fresh
      // code was just emailed.
      setAwaitingCode(true)
      return
    }
    if (result.error) {
      setError(result.error.message ?? "Sign in failed — try again.")
      setPending(false)
      return
    }
    // OAuth is a Django document redirect, not a React page navigation.
    writeLastSignInMethod("password")
    if (next.startsWith("/api/")) {
      window.location.assign(next)
      return
    }
    router.push(next)
    void refresh()
  }

  if (awaitingCode) {
    return <VerifyCodeForm email={email.trim().toLowerCase()} next={next} />
  }

  return (
    <form onSubmit={submit} className="flex flex-col">
      <h1 className={authHeadingClassName}>Welcome back</h1>

      {notice ? (
        <p
          role={notice.role}
          className="mt-4 text-md leading-5 text-muted-foreground"
        >
          {notice.message}
        </p>
      ) : null}

      <div className="mt-8 flex flex-col gap-5">
        <LabeledInput
          label="Email"
          id="login-email"
          type="email"
          autoComplete="email"
          placeholder="you@restaurant.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <div className="flex flex-col gap-2">
          <LabeledInput
            label="Password"
            id="login-password"
            type={passwordVisible ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            trailing={
              <PasswordToggle
                visible={passwordVisible}
                onToggle={() => setPasswordVisible((visible) => !visible)}
              />
            }
          />
          <Link
            href="/forgot-password"
            className="self-start rounded-sm text-sm leading-5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:underline focus-visible:underline-offset-4"
          >
            Forgot your password?
          </Link>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-md leading-5 text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" pending={pending} className="mt-6">
        Sign in
      </Button>

      {googleEnabled ? (
        <>
          <AuthMethodsSeparator />
          <GoogleButton next={next} />
          {lastMethod === "google" ? (
            <p className="mt-3 text-center text-xs text-muted-foreground">
              You signed in with Google last time
            </p>
          ) : null}
        </>
      ) : null}

      <p className={authSwitchClassName}>
        Don&apos;t have an account?{" "}
        <Link
          href={
            next === "/"
              ? "/signup"
              : `/signup?next=${encodeURIComponent(next)}`
          }
          className={authLinkClassName}
        >
          Sign up
        </Link>
      </p>
    </form>
  )
}
