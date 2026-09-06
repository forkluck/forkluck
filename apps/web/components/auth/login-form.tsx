"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { LabeledInput } from "@/components/ui/labeled-field"
import { PasswordToggle } from "@/components/auth/password-toggle"
import { VerifyCodeForm } from "@/components/auth/verify-code-form"
import { authClient } from "@/lib/auth-client"
import { useRefresh } from "@/hooks/use-refresh"

/** `next` is where signing in lands, so a recipe invite reaches its recipe. */
export function LoginForm({ next = "/" }: { next?: string }) {
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
      <h1 className="text-left text-2xl leading-8 font-semibold tracking-[-0.03em]">
        Welcome back
      </h1>
      <p className="mt-2 mb-6 text-left text-lg leading-6 text-muted-foreground">
        Sign in to your kitchen.
      </p>

      <div className="flex flex-col gap-2.5">
        <LabeledInput
          label="Email"
          id="login-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
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
          className="self-start text-md leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline focus-visible:underline-offset-4 focus-visible:outline-none"
        >
          Forgot your password?
        </Link>
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-md leading-5 text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" pending={pending} className="mt-4">
        Sign in
      </Button>

      <p className="mt-4 text-left text-lg leading-6 text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link
          href={
            next === "/"
              ? "/signup"
              : `/signup?next=${encodeURIComponent(next)}`
          }
          className="font-medium text-foreground underline underline-offset-4"
        >
          Sign up
        </Link>
      </p>
    </form>
  )
}
