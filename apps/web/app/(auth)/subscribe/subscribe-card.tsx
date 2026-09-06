"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"
import { useRefresh } from "@/hooks/use-refresh"

import { createStripeCheckout, syncStripeSubscription } from "./actions"

export function SubscribeCard({
  email,
  firstSubscription,
  canReturn,
}: {
  email: string
  firstSubscription: boolean
  canReturn: boolean
}) {
  const router = useRouter()
  const { refresh } = useRefresh()
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  const checkout = () => {
    setError(null)
    startTransition(async () => {
      const result = await createStripeCheckout()
      if ("error" in result) {
        setError(result.error)
        return
      }
      window.location.assign(result.url)
    })
  }

  const syncSubscription = () => {
    setError(null)
    startTransition(async () => {
      const result = await syncStripeSubscription()
      if ("error" in result) {
        setError(result.error)
        return
      }
      void refresh()
    })
  }

  const signOut = async () => {
    const result = await authClient.signOut()
    if (result.error) {
      setError(`Couldn't sign out. ${result.error.message}`)
      return
    }
    router.push("/login")
    void refresh()
  }

  return (
    <div className="flex flex-col">
      <h1 className="text-left text-2xl leading-8 font-semibold tracking-[-0.03em]">
        {firstSubscription ? "Upgrade your account" : "Resubscribe to Forkluck"}
      </h1>
      <p className="mt-2 text-left text-lg leading-6 text-muted-foreground">
        {firstSubscription
          ? "Forkluck is $7 a month. Cancel anytime. Upgrading lifts the 10-recipe limit on the Free plan."
          : "Your subscription has ended and your account is on the Free plan. Forkluck is $7 a month. Cancel anytime. Everything you made is still here."}
      </p>

      {error ? (
        <p role="alert" className="mt-4 text-md leading-5 text-destructive">
          {error}
        </p>
      ) : null}

      <Button size="lg" pending={pending} onClick={checkout} className="mt-4">
        {firstSubscription ? "Upgrade" : "Resubscribe"}
      </Button>

      <button
        type="button"
        onClick={syncSubscription}
        disabled={pending}
        className="mt-4 text-left text-lg leading-6 font-medium text-foreground underline underline-offset-4"
      >
        Already subscribed? Refresh status
      </button>

      {canReturn ? (
        <Link
          href="/"
          className="mt-4 text-left text-lg leading-6 font-medium text-foreground underline underline-offset-4"
        >
          Back to Forkluck
        </Link>
      ) : null}

      <p className="mt-4 text-left text-lg leading-6 text-muted-foreground">
        Signed in as {email} —{" "}
        <button
          type="button"
          onClick={signOut}
          className="font-medium text-foreground underline underline-offset-4"
        >
          Sign out
        </button>
      </p>
    </div>
  )
}
