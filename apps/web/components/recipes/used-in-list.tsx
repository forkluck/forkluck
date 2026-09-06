"use client"

import * as React from "react"

import { Book } from "lucide-react"

import { GuardedLink } from "@/components/navigation-blocker"
import { formatKitchenAmount } from "@/lib/recipe"

export type UsedInRecipe = {
  id: string
  publicId: string
  title: string
  status: "active" | "archived"
  quantity: number | null
  unit: string
}

/** What one recipe calls for, in the fractions the recipe tables use. */
function usedAmount(recipe: UsedInRecipe): string {
  if (recipe.quantity === null) return ""
  return `${formatKitchenAmount(recipe.quantity)} ${recipe.unit}`.trim()
}

/** How many recipes the list holds, for the count beside a heading. */
export function useUsedInRows(usedIn: readonly UsedInRecipe[]) {
  return React.useMemo(
    () =>
      [...usedIn].sort(
        (left, right) =>
          Number(left.status === "archived") -
          Number(right.status === "archived")
      ),
    [usedIn]
  )
}

/**
 * Every recipe that names this one, so a cook can see what a change touches
 * before making it. Archived recipes sink to the bottom: they still count,
 * they just are not on the menu.
 */
export function UsedInList({ rows }: { rows: readonly UsedInRecipe[] }) {
  if (rows.length === 0) {
    return (
      <p className="mt-3 text-base text-muted-foreground">
        No recipe uses this yet.
      </p>
    )
  }
  return (
    <div className="mt-3 divide-y divide-muted border-y border-muted">
      {rows.map((recipe) => (
        <GuardedLink
          key={recipe.id}
          href={`/recipes/${recipe.publicId}/recipe`}
          className="flex min-h-9 items-center gap-2.5 px-1 text-base font-medium text-foreground outline-none hover:bg-fill-soft focus-visible:underline"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
            <Book className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 truncate">{recipe.title}</span>
          {recipe.status === "archived" ? (
            <span className="shrink-0 text-2xs text-muted-foreground">
              Archived
            </span>
          ) : null}
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {usedAmount(recipe)}
          </span>
        </GuardedLink>
      ))}
    </div>
  )
}
