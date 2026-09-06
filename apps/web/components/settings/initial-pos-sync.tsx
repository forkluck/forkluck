"use client"

import * as React from "react"

import { enqueuePosSync } from "@/app/(app)/sales/actions"
import { useToast } from "@/components/ui/toast"

/** Queues the first durable import after a channel is connected. */
export function InitialPosSync({
  provider,
  onComplete,
}: {
  provider: "square" | "shopify"
  onComplete: (provider: "square" | "shopify") => void
}) {
  const hasStarted = React.useRef(false)
  const toast = useToast()

  React.useEffect(() => {
    if (hasStarted.current) return
    hasStarted.current = true

    const url = new URL(window.location.href)
    url.searchParams.delete("connected")
    window.history.replaceState(window.history.state, "", url)

    let cancelled = false
    const queue = async () => {
      try {
        const result = await enqueuePosSync(provider)
        if ("error" in result && !cancelled) {
          toast.add({
            title: "Couldn’t start the initial sync",
            description: result.error,
            type: "error",
          })
        }
      } catch {
        if (!cancelled) {
          toast.add({
            title: "Couldn’t start the initial sync",
            description: "Refresh the page and try again.",
            type: "error",
          })
        }
      } finally {
        // enqueuePosSync revalidates this route itself.
        if (!cancelled) onComplete(provider)
      }
    }
    void queue()

    return () => {
      cancelled = true
    }
  }, [onComplete, provider, toast])

  return <span className="sr-only">Initial sales sync is queued.</span>
}
