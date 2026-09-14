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
  const { go } = useGuardedNavigate()
  const toast = useToast()
  const depsRef = React.useRef({
    run: runKitchenToolAction,
    go,
    toast,
  })
  React.useEffect(() => {
    depsRef.current = { run: runKitchenToolAction, go, toast }
  }, [go, toast])

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
                const { run, go, toast } = depsRef.current
                let toastId: string | undefined
                try {
                  const result = await executeKitchenTool(
                    name,
                    input,
                    {
                      run,
                      navigate: async (href) => {
                        if (!(await go(href)))
                          throw new DOMException(
                            "Navigation cancelled",
                            "AbortError"
                          )
                      },
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
