"use client"

import * as React from "react"

import {
  componentTargets,
  matchTargets,
  TargetSuggestions,
  type ComponentTarget,
} from "@/components/menus/component-targets"
import { Input } from "@/components/ui/input"
import type {
  MenuIngredientOption,
  MenuProductOption,
  MenuRecipeOption,
} from "@/lib/backend/types"

export function componentTargetKey(target: ComponentTarget) {
  return `${target.kind}:${target.id}`
}

/** The Product editor reuses the menu component target/search primitives. */
export function ProductComponentPicker({
  recipes,
  ingredients,
  products,
  selected,
  blockedProductIds,
  onPick,
  autoFocus = false,
}: {
  recipes: MenuRecipeOption[]
  ingredients: MenuIngredientOption[]
  products: MenuProductOption[]
  selected: ReadonlySet<string>
  /** Self and anything that already reaches it — a cycle the server refuses. */
  blockedProductIds: ReadonlySet<string>
  onPick: (target: ComponentTarget) => void
  autoFocus?: boolean
}) {
  const [query, setQuery] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const [highlighted, setHighlighted] = React.useState(-1)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const targets = React.useMemo(
    () => componentTargets(recipes, ingredients, products),
    [ingredients, products, recipes]
  )
  const rows = React.useMemo(
    () =>
      matchTargets(
        targets.filter(
          (target) =>
            !selected.has(componentTargetKey(target)) &&
            !(target.kind === "product" && blockedProductIds.has(target.id))
        ),
        query
      ),
    [blockedProductIds, query, selected, targets]
  )

  const pick = (target: ComponentTarget) => {
    onPick(target)
    setQuery("")
    setOpen(false)
    setHighlighted(-1)
  }

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        autoFocus={autoFocus}
        value={query}
        placeholder="Search a recipe, product, ingredient or supply"
        aria-label="Add product component"
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false)
          setHighlighted(-1)
        }}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
          setHighlighted(-1)
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && rows.length) {
            event.preventDefault()
            setHighlighted((current) =>
              current >= rows.length - 1 ? 0 : current + 1
            )
          } else if (event.key === "ArrowUp" && rows.length) {
            event.preventDefault()
            setHighlighted((current) =>
              current <= 0 ? rows.length - 1 : current - 1
            )
          } else if (event.key === "Escape") {
            setOpen(false)
            setHighlighted(-1)
          } else if (event.key === "Enter" && highlighted >= 0) {
            event.preventDefault()
            const target = rows[highlighted]
            if (target) pick(target)
          }
        }}
      />
      {open && query.trim() ? (
        <TargetSuggestions
          anchor={inputRef}
          rows={rows}
          highlighted={highlighted}
          onPick={pick}
        />
      ) : null}
    </div>
  )
}
