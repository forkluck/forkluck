"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { useRefresh } from "@/hooks/use-refresh"

import { syncStripeSubscription } from "../actions"

const SYNC_ATTEMPTS = 8
const SYNC_DELAY_MS = 500

export function ConfirmSubscription({ sessionId }: { sessionId?: string }) {
  const router = useRouter()
  const { refresh } = useRefresh()
  const [error, setError] = React.useState<string | null>(null)
  const [waiting, setWaiting] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const run = React.useRef(0)

  const confirm = React.useCallback(async () => {
    const currentRun = ++run.current
    setError(null)
    setWaiting(false)
    setPending(true)
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt += 1) {
      const result = await syncStripeSubscription(sessionId)
      if (currentRun !== run.current) return
      if ("error" in result) {
        setError(result.error)
        setPending(false)
        return
      }
      if (result.plan === "paid") {
        router.replace("/")
        void refresh()
        return
      }
      if (attempt < SYNC_ATTEMPTS - 1) {
        setWaiting(true)
        await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY_MS))
      }
    }
    setPending(false)
    setError(
      "Stripe is still finalizing your subscription. Wait a moment, then retry."
    )
  }, [refresh, router, sessionId])

  React.useEffect(() => {
    // The sync has to start on arrival — Stripe already redirected — and its
    // state changes report progress from that provider round trip.
    React.startTransition(() => {
      void confirm()
    })
    return () => {
      run.current += 1
    }
  }, [confirm])

  return (
    <div className="flex flex-col">
      <h1 className="text-left text-2xl leading-8 font-semibold tracking-[-0.03em]">
        We’re confirming your subscription…
      </h1>
      {waiting && !error ? (
        <p
          role="status"
          className="mt-4 text-md leading-5 text-muted-foreground"
        >
          Payment received. Waiting for Stripe to finish activating your
          account…
        </p>
      ) : null}
      {error ? (
        <>
          <p role="alert" className="mt-4 text-md leading-5 text-destructive">
            {error}
          </p>
          <Button
            size="lg"
            pending={pending}
            onClick={() => {
              void confirm()
            }}
            className="mt-4"
          >
            Retry
          </Button>
        </>
      ) : null}
    </div>
  )
}
