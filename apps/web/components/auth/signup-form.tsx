"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { AuthMethodsSeparator } from "@/components/auth/auth-methods-separator"
import { GoogleButton } from "@/components/auth/google-button"
import { writeLastSignInMethod } from "@/components/auth/last-sign-in-method"
import { Button } from "@/components/ui/button"
import { LabeledInput } from "@/components/ui/labeled-field"
import {
  authHeadingClassName,
  authLinkClassName,
  authSubtitleClassName,
  authSwitchClassName,
} from "@/components/auth/auth-styles"
import { PasswordHint } from "@/components/auth/password-hint"
import { PasswordToggle } from "@/components/auth/password-toggle"
import { TurnstileWidget } from "@/components/auth/turnstile-widget"
import { VerifyCodeForm } from "@/components/auth/verify-code-form"
import { authClient } from "@/lib/auth-client"
import { useRefresh } from "@/hooks/use-refresh"

// How long a submit waits for Cloudflare's token before giving up. The
// invisible check normally answers well under a second after the page loads.
const TOKEN_WAIT_MS = 10_000
const NOT_CONFIRMED =
  "We couldn't confirm you're a person. Reload the page and try again."

export function SignupForm({
  next = "/",
  googleEnabled = false,
  turnstileSiteKey = null,
}: {
  next?: string
  googleEnabled?: boolean
  /** Cloudflare Turnstile site key, or null when the check is off. */
  turnstileSiteKey?: string | null
}) {
  const router = useRouter()
  const { refresh } = useRefresh()
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [passwordVisible, setPasswordVisible] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [awaitingCode, setAwaitingCode] = React.useState(false)
  const [resetSignal, setResetSignal] = React.useState(0)
  // The latest single-use token, and the submits waiting for one. Refs, not
  // state: a token arriving must not re-render the form.
  const tokenRef = React.useRef<string | null>(null)
  const waitersRef = React.useRef<Array<(token: string) => void>>([])

  const receiveToken = React.useCallback((token: string | null) => {
    tokenRef.current = token
    if (token === null) return
    const waiters = waitersRef.current
    waitersRef.current = []
    for (const settle of waiters) settle(token)
  }, [])

  const awaitToken = () =>
    new Promise<string | null>((resolve) => {
      if (tokenRef.current) {
        resolve(tokenRef.current)
        return
      }
      const settle = (token: string) => {
        window.clearTimeout(timer)
        resolve(token)
      }
      const timer = window.setTimeout(() => {
        waitersRef.current = waitersRef.current.filter((w) => w !== settle)
        resolve(null)
      }, TOKEN_WAIT_MS)
      waitersRef.current.push(settle)
    })

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError("Enter your name.")
      return
    }
    if (!email.trim()) {
      setError("Enter your email.")
      return
    }
    if (password.length < 8) {
      setError("Use at least 8 characters.")
      return
    }
    setPending(true)
    let turnstileToken: string | null = null
    if (turnstileSiteKey) {
      turnstileToken = await awaitToken()
      if (!turnstileToken) {
        setError(NOT_CONFIRMED)
        setPending(false)
        setResetSignal((n) => n + 1)
        return
      }
      // Single use: the next submit waits for a fresh one.
      tokenRef.current = null
    }
    const result = await authClient.signUp.email(
      turnstileToken
        ? { name, email, password, turnstileToken }
        : { name, email, password }
    )
    if (result.pendingVerification) {
      setAwaitingCode(true)
      return
    }
    if (result.error) {
      setError(result.error.message ?? "Sign up failed. Try again.")
      setPending(false)
      if (turnstileSiteKey) setResetSignal((n) => n + 1)
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

  if (awaitingCode) {
    return <VerifyCodeForm email={email.trim().toLowerCase()} next={next} />
  }

  return (
    <form onSubmit={submit} className="flex flex-col" data-auth-form="signup">
      <h1 className={authHeadingClassName}>Create your account</h1>
      <p className={authSubtitleClassName}>
        Every feature free for 14 days. No card needed.
      </p>

      <div className="mt-8 flex flex-col gap-5">
        <LabeledInput
          label="Name"
          id="signup-name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <LabeledInput
          label="Email"
          id="signup-email"
          type="email"
          autoComplete="email"
          placeholder="you@restaurant.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <div className="flex flex-col gap-2">
          <LabeledInput
            label="Password"
            id="signup-password"
            type={passwordVisible ? "text" : "password"}
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            trailing={
              <PasswordToggle
                visible={passwordVisible}
                onToggle={() => setPasswordVisible((visible) => !visible)}
              />
            }
          />
          <PasswordHint password={password} />
        </div>
      </div>

      {turnstileSiteKey ? (
        <TurnstileWidget
          siteKey={turnstileSiteKey}
          onToken={receiveToken}
          resetSignal={resetSignal}
        />
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 text-md leading-5 text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" pending={pending} className="mt-6">
        Create account
      </Button>

      {googleEnabled ? (
        <>
          <AuthMethodsSeparator />
          <GoogleButton next={next} />
        </>
      ) : null}

      <p className={authSwitchClassName}>
        Already have an account?{" "}
        <Link
          href={
            next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`
          }
          className={authLinkClassName}
        >
          Sign in
        </Link>
      </p>
    </form>
  )
}
