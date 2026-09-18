"use client"

import { ExternalLink } from "lucide-react"
import { GuardedLink } from "@/components/navigation-blocker"
import { Button } from "@/components/ui/button"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { formatFullDate } from "@/lib/datetime"
import type { RecipeCostDiff } from "@/lib/backend/types"

export function PrimoCostLinks({
  result,
  onSuggestion,
}: {
  result: RecipeCostDiff
  onSuggestion: (question: string) => void
}) {
  const { timezone } = useBusinessSettings()
  const previous =
    result.priceChangesInWindow === 0 ? result.lastChangeBeforeWindow : null
  const changedIngredients = new Map(
    result.lines
      .filter(
        (line) =>
          line.ingredientPublicId &&
          line.deltaCents !== null &&
          line.deltaCents !== 0
      )
      .map((line) => [line.ingredientPublicId!, line.name])
  )
  return (
    <div className="flex flex-wrap gap-2">
      {previous ? (
        <Button
          variant="secondary"
          onClick={() =>
            onSuggestion(
              `Compare this recipe since ${formatFullDate(new Date(previous.at), timezone)}.`
            )
          }
        >
          Compare since {formatFullDate(new Date(previous.at), timezone)}
        </Button>
      ) : null}
      <Button
        render={
          <GuardedLink href={`/recipes/${result.recipe.publicId}/cost`} />
        }
        variant="ghost"
      >
        Open Cost tab
        <ExternalLink data-icon="inline-end" aria-hidden="true" />
      </Button>
      {[...changedIngredients].map(([ref, name]) => (
        <Button
          key={ref}
          render={<GuardedLink href={`/ingredients/${ref}`} />}
          variant="ghost"
        >
          {name}
          <ExternalLink data-icon="inline-end" aria-hidden="true" />
        </Button>
      ))}
    </div>
  )
}
