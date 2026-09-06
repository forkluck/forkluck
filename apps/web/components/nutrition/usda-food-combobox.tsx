"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { ChevronDown, X } from "lucide-react"

import {
  searchNutritionFoods,
  type NutritionFoodMatch,
  type NutritionSearchScope,
} from "@/app/(app)/ingredients/actions"
import { SearchInput } from "@/components/ui/input"
import { TabPill, TabPills } from "@/components/ui/tab-pills"
import { useDebouncedCallback } from "@/hooks/use-debounced-callback"
import { cn } from "@/lib/utils"

export type LinkedNutrition = {
  source: "usda_fdc" | "custom"
  description: string
}

/** "USDA" on a FoodData Central record, "Custom" on a value support applied. */
export function nutritionSourceLabel(source: LinkedNutrition["source"]) {
  return source === "custom" ? "Custom" : "USDA"
}

/**
 * Picks the USDA FoodData Central record an ingredient's nutrition comes
 * from. The search runs as the cook types, 300 ms after the last keystroke
 * and from two characters; the Common / Branded pills run it again over the
 * other catalog.
 */
export function UsdaFoodCombobox({
  value,
  onChoose,
  onClear,
  disabled = false,
}: {
  value: LinkedNutrition | null
  onChoose: (match: NutritionFoodMatch) => void | Promise<void>
  onClear: () => void | Promise<void>
  disabled?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [scope, setScope] = React.useState<NutritionSearchScope>("common")
  const [results, setResults] = React.useState<NutritionFoodMatch[]>([])
  const [searching, setSearching] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  // A slow answer to an older query must not land over a newer one.
  const requestRef = React.useRef(0)

  const runSearch = React.useCallback(
    async (text: string, nextScope: NutritionSearchScope) => {
      const trimmed = text.trim()
      if (trimmed.length < 2) {
        setResults([])
        setMessage(null)
        setSearching(false)
        return
      }
      const request = ++requestRef.current
      setSearching(true)
      setMessage(null)
      const result = await searchNutritionFoods(trimmed, nextScope)
      if (request !== requestRef.current) return
      setSearching(false)
      if ("error" in result) {
        setResults([])
        setMessage(result.error)
        return
      }
      setResults(result.items)
      setMessage(
        result.items.length === 0 ? "No foods match. Try fewer words." : null
      )
    },
    []
  )
  const searchSoon = useDebouncedCallback(
    (text: string, nextScope: NutritionSearchScope) =>
      void runSearch(text, nextScope),
    300
  )

  const choose = async (match: NutritionFoodMatch) => {
    setOpen(false)
    await onChoose(match)
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setQuery("")
          setResults([])
          setMessage(null)
        }
      }}
    >
      <Popover.Trigger
        aria-label="Nutrition data"
        disabled={disabled}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-card px-3 text-left text-md outline-none focus-visible:border-foreground enabled:not-focus:hover:border-line-strong disabled:cursor-not-allowed disabled:border-border disabled:text-disabled-foreground data-popup-open:bg-accent",
          !value && "text-faint"
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {value ? (
            <span className="shrink-0 rounded-sm bg-secondary px-[7px] py-0.5 text-2xs font-medium text-secondary-foreground">
              {nutritionSourceLabel(value.source)}
            </span>
          ) : null}
          <span className="truncate">
            {value ? value.description : "Search USDA foods"}
          </span>
        </span>
        <ChevronDown
          className="size-[13px] shrink-0 text-muted-foreground"
          strokeWidth={2}
          aria-hidden="true"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={4} className="z-50">
          <Popover.Popup className="z-50 w-(--anchor-width) max-w-(--available-width) min-w-[320px] origin-(--transform-origin) rounded-lg border border-popover-border bg-popover text-popover-foreground outline-none">
            <Popover.Title className="sr-only">Choose a food</Popover.Title>
            <div className="flex items-center gap-2 p-1.5">
              <SearchInput
                autoFocus
                maxLength={120}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  searchSoon(event.target.value, scope)
                }}
                placeholder="Search USDA foods"
                aria-label="Search USDA foods"
                className="max-w-none flex-1"
                inputClassName="h-8"
              />
              <TabPills>
                {(["common", "branded"] as const).map((entry) => (
                  <TabPill
                    key={entry}
                    active={scope === entry}
                    onClick={() => {
                      if (scope === entry) return
                      setScope(entry)
                      void runSearch(query, entry)
                    }}
                  >
                    {entry === "common" ? "Common" : "Branded"}
                  </TabPill>
                ))}
              </TabPills>
            </div>
            <div className="flex max-h-72 flex-col overflow-y-auto p-1.5 pt-0">
              {value ? (
                <button
                  type="button"
                  onClick={async () => {
                    setOpen(false)
                    await onClear()
                  }}
                  className="flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
                >
                  <X className="size-[15px] shrink-0" aria-hidden="true" />
                  Clear
                </button>
              ) : null}
              {searching ? (
                <span className="flex h-9 shrink-0 items-center px-2.5 text-base text-faint">
                  Searching
                </span>
              ) : message ? (
                <span className="flex min-h-9 shrink-0 items-center px-2.5 text-base text-faint">
                  {message}
                </span>
              ) : null}
              {results.map((match) => (
                <button
                  key={match.fdcId}
                  type="button"
                  onClick={() => void choose(match)}
                  className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {match.description}
                  </span>
                  {match.brand ? (
                    <span className="shrink-0 rounded-sm bg-secondary px-[7px] py-0.5 text-2xs font-medium text-secondary-foreground">
                      {match.brand}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
