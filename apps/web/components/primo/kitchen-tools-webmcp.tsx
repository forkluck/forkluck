"use client"

import * as React from "react"

import { runKitchenToolAction } from "@/app/(app)/actions"
import { usePrimo } from "@/components/primo/primo-provider"
import { executeKitchenTool } from "@/lib/primo/kitchen-tool-client"
import type {
  KitchenToolDescriptor,
  KitchenToolName,
} from "@/lib/primo/kitchen-tools"

export function KitchenToolsWebMcp({
  tools,
}: {
  tools: KitchenToolDescriptor[]
}) {
  const { navigate, showAction } = usePrimo()
  const depsRef = React.useRef({
    run: runKitchenToolAction,
    navigate,
    showAction,
  })
  React.useEffect(() => {
    depsRef.current = { run: runKitchenToolAction, navigate, showAction }
  }, [navigate, showAction])

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
              execute: (input, { signal }) =>
                executeKitchenTool(name, input, depsRef.current, signal),
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
