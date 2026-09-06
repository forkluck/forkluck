"use client"

import * as React from "react"
import Link from "next/link"

import { Button, buttonVariants } from "@/components/ui/button"
import { LabeledInput } from "@/components/ui/labeled-field"
import { PasswordToggle } from "@/components/auth/password-toggle"
import { authClient } from "@/lib/auth-client"
import { cn } from "@/lib/utils"

type Stage = "request" | "reset" | "complete"

export function ForgotPasswordForm() {
  const [stage, setStage] = React.useState<Stage>("request")
  const [email, setEmail] = React.useState("")
  const [code, setCode] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [passwordVisible, setPasswordVisible] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [resent, setResent] = React.useState(false)

  const requestCode = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!email.trim()) {
      setError("Enter your email.")
      return
    }
    setPending(true)
    const result = await authClient.requestPasswordReset({ email })
    setPending(false)
    if (result.error) {
      setError(result.error.message)
      return
    }
    setStage("reset")
  }

  const resetPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (code.length !== 6) {
      setError("Enter the 6-digit reset code.")
      return
    }
    if (password.length < 8) {
      setError("Use at least 8 characters.")
      return
    }
    setPending(true)
    const result = await authClient.resetPassword({ email, code, password })
    setPending(false)
    if (result.error) {
      setError(result.error.message)
      return
    }
    setStage("complete")
  }

  const resendCode = async () => {
    setError(null)
    setResent(false)
    setPending(true)
    const result = await authClient.requestPasswordReset({ email })
    setPending(false)
    if (result.error) {
      setError(result.error.message)
      return
    }
    setResent(true)
  }

  if (stage === "complete") {
    return (
      <div className="flex flex-col text-left">
        <h1 className="text-2xl leading-8 font-semibold tracking-[-0.03em]">
          Password reset
        </h1>
        <p className="mt-2 text-lg leading-6 text-muted-foreground">
          Your password has been changed. You can now sign in with your new
          password.
        </p>
        <Link
          href="/login"
          className={cn(buttonVariants({ size: "lg" }), "mt-6")}
        >
          Sign in
        </Link>
      </div>
    )
  }

  if (stage === "request") {
    return (
      <form onSubmit={requestCode} className="flex flex-col">
        <h1 className="text-left text-2xl leading-8 font-semibold tracking-[-0.03em]">
          Reset your password
        </h1>
        <p className="mt-2 text-left text-lg leading-6 text-muted-foreground">
          We&apos;ll email you a code.
        </p>

        <LabeledInput
          label="Email"
          id="forgot-password-email"
          type="email"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={Boolean(error)}
          containerClassName="mt-6"
        />

        {error ? (
          <p role="alert" className="mt-4 text-md leading-5 text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="lg" pending={pending} className="mt-4">
          Send reset code
        </Button>

        <p className="mt-4 text-left text-lg leading-6 text-muted-foreground">
          Remembered it?{" "}
          <Link
            href="/login"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Sign in
          </Link>
        </p>
      </form>
    )
  }

  return (
    <form onSubmit={resetPassword} className="flex flex-col md:-translate-y-12">
      <h1 className="text-left text-2xl leading-8 font-semibold tracking-[-0.03em]">
        Check your email
      </h1>
      <p className="mt-2 text-left text-lg leading-6 text-muted-foreground">
        We sent a 6-digit reset code to {email.trim().toLowerCase()}.
      </p>

      <div className="mt-6 flex flex-col gap-2.5">
        <LabeledInput
          label="Reset code"
          id="password-reset-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          aria-invalid={Boolean(error)}
          className="tracking-[0.24em] tabular-nums"
        />
        <LabeledInput
          label="New password"
          id="password-reset-new-password"
          type={passwordVisible ? "text" : "password"}
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={Boolean(error)}
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

      {resent ? (
        <p
          role="status"
          className="mt-4 text-md leading-5 text-muted-foreground"
        >
          A new code is on its way.
        </p>
      ) : null}

      <Button type="submit" size="lg" pending={pending} className="mt-4">
        Reset password
      </Button>

      <button
        type="button"
        onClick={resendCode}
        disabled={pending}
        className="mt-4 text-left text-lg leading-6 font-medium text-foreground underline underline-offset-4 disabled:pointer-events-none disabled:opacity-50"
      >
        Send a new code
      </button>
    </form>
  )
}
