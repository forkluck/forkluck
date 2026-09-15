"use client"

import * as React from "react"

import { runKitchenToolAction } from "@/app/(app)/actions"
import { useGuardedNavigate } from "@/components/navigation-blocker"
import { useToast } from "@/components/ui/toast"
import { executeKitchenTool } from "@/lib/kitchen-tools/client"
import type {
  KitchenToolDescriptor,
  KitchenToolName,
} from "@/lib/kitchen-tools/catalog"

export function KitchenToolsWebMcp({
  tools,
}: {
  tools: KitchenToolDescriptor[]
}) {
  const { go, pending } = useGuardedNavigate()
  const toast = useToast()
  const pendingNavigation = React.useRef<{
    sawPending: boolean
    settle: () => void
  } | null>(null)

  React.useEffect(() => {
    const waiting = pendingNavigation.current
    if (!waiting) return
    if (pending) {
      waiting.sawPending = true
    } else if (waiting.sawPending) {
      waiting.settle()
    }
  }, [pending])

  React.useEffect(
    () => () => {
      pendingNavigation.current?.settle()
    },
    []
  )

  // A browser agent gets its result only after the screen has changed:
  // resolve once the route transition settles, raced against three seconds.
  const navigate = React.useCallback(
    async (href: string) => {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        pendingNavigation.current?.settle()
        let timeout = 0
        const settle = (cause?: unknown) => {
          if (settled) return
          settled = true
          window.clearTimeout(timeout)
          pendingNavigation.current = null
          if (cause === undefined) resolve()
          else reject(cause)
        }
        pendingNavigation.current = { sawPending: false, settle }
        timeout = window.setTimeout(settle, 3_000)
        go(href).then(
          (allowed) => {
            if (!allowed)
              settle(new DOMException("Navigation cancelled", "AbortError"))
          },
          (cause) => settle(cause ?? new Error("Navigation failed"))
        )
      })
    },
    [go]
  )

  const depsRef = React.useRef({
    run: runKitchenToolAction,
    navigate,
    toast,
  })
  React.useEffect(() => {
    depsRef.current = { run: runKitchenToolAction, navigate, toast }
  }, [navigate, toast])

  React.useEffect(() => {
    if (!("modelContext" in document) || !document.modelContext) return
    const controller = new AbortController()
    let logged = false
    for (const descriptor of tools) {
      const name = descriptor.name as KitchenToolName
      try {
        void Promise.resolve(
          document.modelContext.registerTool(
            {
              ...descriptor,
              execute: async (input, { signal }) => {
                const { run, navigate, toast } = depsRef.current
                let toastId: string | undefined
                try {
                  const result = await executeKitchenTool(
                    name,
                    input,
                    {
                      run,
                      navigate,
                      showAction: (title) => {
                        toastId = toast.add({ title, timeout: 0 })
                      },
                    },
                    AbortSignal.any([signal, controller.signal])
                  )
                  if (toastId)
                    toast.update(toastId, {
                      title: result.ok
                        ? "Kitchen read complete"
                        : result.message,
                      type: result.ok ? "success" : "error",
                      timeout: 5_000,
                    })
                  return result
                } catch (cause) {
                  if (toastId) {
                    if (
                      (cause instanceof DOMException ||
                        cause instanceof Error) &&
                      cause.name === "AbortError"
                    )
                      toast.close(toastId)
                    else
                      toast.update(toastId, {
                        title: "Couldn't complete that kitchen read.",
                        type: "error",
                        timeout: 5_000,
                      })
                  }
                  throw cause
                }
              },
            },
            { signal: controller.signal }
          )
        ).catch(() => {
          if (logged) return
          logged = true
          console.info("WebMCP tools are unavailable in this browser.")
        })
      } catch {
        if (!logged) {
          logged = true
          console.info("WebMCP tools are unavailable in this browser.")
        }
      }
    }
    return () => controller.abort()
  }, [tools])

  return null
}
