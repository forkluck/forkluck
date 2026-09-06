"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"

import { Badge } from "@/components/ui/badge"
import type {
  MenuIngredientOption,
  MenuProductOption,
  MenuRecipeOption,
} from "@/lib/backend/types"
import { fuzzyMatches } from "@/lib/fuzzy"
import { KNOWN_UNITS } from "@/lib/unit-registry"
import { cn } from "@/lib/utils"

/** One recipe or one ingredient of a composition, in the quantity it uses. */
export type MenuComponentState = {
  key: string
  recipeId: string | null
  ingredientId: string | null
  quantity: number
  unit: string
  unitCostCents: number | null
}

let sequence = 0

export function newComponentKey() {
  sequence += 1
  return `component-${sequence}`
}

export type MenuComponentTarget =
  | { kind: "recipe"; id: string; name: string; recipe: MenuRecipeOption }
  | {
      kind: "ingredient"
      id: string
      name: string
      /** The ingredient's purchase unit, the component's default. */
      purchaseUnit: string | null
      /** Ingredients can be direct supplies; recipes are always edible. */
      nonEdible: boolean
    }

/** A recipe, an ingredient or another product, as the pickers see all three. */
export type ComponentTarget =
  | MenuComponentTarget
  | { kind: "product"; id: string; name: string; publicId: string }

export function componentTargets(
  recipes: readonly MenuRecipeOption[],
  ingredients: readonly MenuIngredientOption[]
): MenuComponentTarget[]
export function componentTargets(
  recipes: readonly MenuRecipeOption[],
  ingredients: readonly MenuIngredientOption[],
  products: readonly MenuProductOption[]
): ComponentTarget[]
export function componentTargets(
  recipes: readonly MenuRecipeOption[],
  ingredients: readonly MenuIngredientOption[],
  products: readonly MenuProductOption[] = []
): ComponentTarget[] {
  return [
    ...recipes.map((recipe) => ({
      kind: "recipe" as const,
      id: recipe.id,
      name: recipe.title,
      recipe,
    })),
    ...ingredients.map((ingredient) => ({
      kind: "ingredient" as const,
      id: ingredient.id,
      name: ingredient.name,
      purchaseUnit: ingredient.purchaseUnit,
      nonEdible: ingredient.nonEdible,
    })),
    ...products.map((product) => ({
      kind: "product" as const,
      id: product.id,
      name: product.name,
      publicId: product.publicId,
    })),
  ]
}

export function matchTargets<T extends ComponentTarget>(
  targets: readonly T[],
  query: string
) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return targets.slice(0, 20)
  return targets
    .filter((row) => fuzzyMatches(row.name.toLocaleLowerCase(), needle))
    .slice(0, 20)
}

export function TargetSuggestions<T extends ComponentTarget>({
  rows,
  highlighted,
  onPick,
  footers,
  anchor,
}: {
  rows: T[]
  highlighted: number
  onPick: (row: T) => void
  /** Offered under the matches, for a row that is none of them. */
  footers?: { label: string; onClick: () => void }[]
  /** The field the list hangs under. */
  anchor: React.RefObject<HTMLElement | null>
}) {
  // Floated in a portal rather than drawn inside the cell: the menu table
  // scrolls sideways, and a scroll box clips anything positioned inside it,
  // so an in-cell list was there in the DOM and invisible on the page.
  return (
    <Popover.Root open modal={false}>
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50"
        >
          <Popover.Popup
            role="listbox"
            initialFocus={false}
            finalFocus={false}
            className="max-h-60 w-(--anchor-width) min-w-[240px] overflow-y-auto rounded-lg border border-popover-border bg-popover p-1.5 text-popover-foreground outline-none"
          >
            {rows.map((row, index) => (
              <button
                key={`${row.kind}:${row.id}`}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                data-highlighted={index === highlighted || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(row)}
                className={cn(
                  "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent",
                  index === highlighted && "bg-accent"
                )}
              >
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.kind === "recipe" ? (
                  <Badge variant="secondary">Recipe</Badge>
                ) : row.kind === "product" ? (
                  <Badge variant="secondary">Product</Badge>
                ) : row.nonEdible ? (
                  <Badge variant="outline">Supply</Badge>
                ) : null}
              </button>
            ))}
            {(footers ?? []).map((footer) => (
              <button
                key={footer.label}
                type="button"
                className="flex h-9 w-full items-center rounded-md px-2.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
                onMouseDown={(event) => event.preventDefault()}
                onClick={footer.onClick}
              >
                {footer.label}
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** ArrowUp/ArrowDown wrap the list, Escape drops the highlight. True when the
 * key belonged to the list rather than the field. */
export function navigateSuggestions(
  event: React.KeyboardEvent,
  count: number,
  setHighlighted: React.Dispatch<React.SetStateAction<number>>
) {
  if (event.key === "ArrowDown" && count > 0) {
    event.preventDefault()
    setHighlighted((index) => (index >= count - 1 ? 0 : index + 1))
    return true
  }
  if (event.key === "ArrowUp" && count > 0) {
    event.preventDefault()
    setHighlighted((index) => (index <= 0 ? count - 1 : index - 1))
    return true
  }
  if (event.key === "Escape") {
    setHighlighted(-1)
    return true
  }
  return false
}

/** What a picked target starts as: a recipe is priced from the options, an
 * ingredient waits for the server to price its purchase unit. */
export function componentFromTarget(
  target: MenuComponentTarget
): MenuComponentState {
  if (target.kind === "recipe") {
    return {
      key: newComponentKey(),
      recipeId: target.id,
      ingredientId: null,
      quantity: 1,
      unit: "",
      unitCostCents: target.recipe.ingredientCents,
    }
  }
  // A purchase unit is free text (legacy "pcs", invoice pack words); only a
  // vocabulary slug can be saved on a component.
  const purchaseUnit =
    target.purchaseUnit === "pcs" ? "each" : target.purchaseUnit
  const unit = purchaseUnit && KNOWN_UNITS[purchaseUnit] ? purchaseUnit : "each"
  return {
    key: newComponentKey(),
    recipeId: null,
    ingredientId: target.id,
    quantity: 1,
    unit,
    unitCostCents: null,
  }
}
