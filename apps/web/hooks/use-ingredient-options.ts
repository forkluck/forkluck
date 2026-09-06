"use client"

import * as React from "react"

import { loadIngredientOptions } from "@/app/(app)/actions"
import type { IngredientOption } from "@/components/ingredients/types"

export function useIngredientOptions() {
  const [options, setOptions] = React.useState<IngredientOption[]>([])
  const [status, setStatus] = React.useState<
    "idle" | "loading" | "ready" | "error"
  >("idle")

  // A list that is already here stays usable while a fresh one is fetched:
  // only the first load has nothing to show, and only its failure is an error.
  const load = React.useCallback(async () => {
    setStatus((current) => (current === "ready" ? "ready" : "loading"))
    try {
      setOptions(await loadIngredientOptions())
      setStatus("ready")
    } catch {
      setStatus((current) => (current === "ready" ? "ready" : "error"))
    }
  }, [])

  /** An ingredient made mid-session (from the catalog, say) joins the list
   * at once, so every picker on the screen can name it before a reload. */
  const add = React.useCallback((option: IngredientOption) => {
    setOptions((current) =>
      current.some((item) => item.id === option.id)
        ? current
        : [...current, option]
    )
  }, [])

  return { options, status, load, add }
}
