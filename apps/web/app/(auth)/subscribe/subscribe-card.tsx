"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import {
  authHeadingClassName,
  authLinkClassName,
  authSubtitleClassName,
  authSwitchClassName,
} from "@/components/auth/auth-styles"
import { authClient } from "@/lib/auth-client"
import { trialDaysLeftLabel } from "@/lib/billing"
import { cn } from "@/lib/utils"
import { useRefresh } from "@/hooks/use-refresh"

import { createStripeCheckout, syncStripeSubscription } from "./actions"

/** Where the account stands: a running trial, a trial that ran out, or a
 * subscription that ended. */
export type SubscribeState = "trial" | "trialEnded" | "lapsed"

function subscribeCopy(state: SubscribeState, trialDaysLeft: number | null) {
  switch (state) {
    case "trial":
      return {
        heading: "Subscribe to Forkluck",
        body: `Forkluck is $7 a month. Cancel anytime. You have ${trialDaysLeftLabel(trialDaysLeft ?? 0)} in your trial, and subscribing keeps everything as it is.`,
        button: "Subscribe",
      }
    case "trialEnded":
      return {
        heading: "Subscribe to Forkluck",
        body: "Your trial has ended. Subscribe to keep editing. Everything you made is still here.",
        button: "Subscribe",
      }
    case "lapsed":
      return {
        heading: "Resubscribe to Forkluck",
        body: "Your subscription has ended. Forkluck is $7 a month. Cancel anytime. Everything you made is still here.",
        button: "Resubscribe",
      }
  }
}

export function SubscribeCard({
  email,
  state,
  trialDaysLeft = null,
  canReturn,
}: {
  email: string
  state: SubscribeState
  trialDaysLeft?: number | null
  canReturn: boolean
}) {
  const copy = subscribeCopy(state, trialDaysLeft)
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

  const secondaryClassName = cn(
    "mt-6 self-center text-sm leading-5",
    authLinkClassName
  )

  return (
    <div className="flex flex-col">
      <h1 className={authHeadingClassName}>{copy.heading}</h1>
      <p className={authSubtitleClassName}>{copy.body}</p>

      {error ? (
        <p role="alert" className="mt-4 text-md leading-5 text-destructive">
          {error}
        </p>
      ) : null}

      <Button size="lg" pending={pending} onClick={checkout} className="mt-6">
        {copy.button}
      </Button>

      <button
        type="button"
        onClick={syncSubscription}
        disabled={pending}
        className={secondaryClassName}
      >
        Already subscribed? Refresh status
      </button>

      {canReturn ? (
        <Link href="/" className={secondaryClassName}>
          Back to Forkluck
        </Link>
      ) : null}

      <p className={authSwitchClassName}>
        Signed in as {email}.{" "}
        <button type="button" onClick={signOut} className={authLinkClassName}>
          Sign out
        </button>
      </p>
    </div>
  )
}
