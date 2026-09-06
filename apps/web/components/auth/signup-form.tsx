"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { LabeledInput } from "@/components/ui/labeled-field"
import { PasswordToggle } from "@/components/auth/password-toggle"
import { VerifyCodeForm } from "@/components/auth/verify-code-form"
import { authClient } from "@/lib/auth-client"
import { MARKETING_ORIGIN } from "@/lib/public-site"
import { useRefresh } from "@/hooks/use-refresh"

export function SignupForm({ next = "/" }: { next?: string }) {
  const router = useRouter()
  const { refresh } = useRefresh()
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [passwordVisible, setPasswordVisible] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [awaitingCode, setAwaitingCode] = React.useState(false)

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
    const result = await authClient.signUp.email({ name, email, password })
    if (result.pendingVerification) {
      setAwaitingCode(true)
      return
    }
    if (result.error) {
      setError(result.error.message ?? "Sign up failed — try again.")
      setPending(false)
      return
    }
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
    <>
      <form onSubmit={submit} className="flex flex-col" data-auth-form="signup">
        <h1 className="text-left text-2xl leading-8 font-semibold tracking-[-0.03em]">
          Create your account
        </h1>
        <p className="mt-2 mb-6 text-left text-lg leading-6 text-muted-foreground">
          Free to start. No card needed.
        </p>

        <div className="flex flex-col gap-2.5">
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
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
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
          <p className="text-md leading-5 text-muted-foreground">
            At least 8 characters.
          </p>
        </div>

        {error ? (
          <p role="alert" className="mt-4 text-md leading-5 text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="lg" pending={pending} className="mt-4">
          Create account
        </Button>

        <p className="mt-4 text-left text-lg leading-6 text-muted-foreground">
          Already have an account?{" "}
          <Link
            href={
              next === "/"
                ? "/login"
                : `/login?next=${encodeURIComponent(next)}`
            }
            className="font-medium text-foreground underline underline-offset-4"
          >
            Sign in
          </Link>
        </p>
      </form>

      <p className="mt-8 text-left text-xs leading-5 text-muted-foreground">
        By creating an account, you agree to our{" "}
        <a
          href={`${MARKETING_ORIGIN}/terms`}
          className="font-medium text-foreground underline underline-offset-4"
        >
          Terms of Service
        </a>{" "}
        and have read and understood the{" "}
        <a
          href={`${MARKETING_ORIGIN}/privacy`}
          className="font-medium text-foreground underline underline-offset-4"
        >
          Privacy Policy
        </a>
        {". We'll send occasional product updates. Unsubscribe anytime."}
      </p>
    </>
  )
}
