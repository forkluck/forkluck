import { notFound } from "next/navigation"

import { RecipeCostView } from "@/components/recipes/recipe-cost-view"
import { getPricingEntries, getRecipe } from "@/lib/backend/queries"
import { YIELD_UNITS, type YieldUnit } from "@/lib/units"
import { recipePrepTimeSeconds } from "@/lib/recipe/portions"

export default async function RecipeCostPage({
  params,
}: {
  params: Promise<{ recipeId: string }>
}) {
  const { recipeId } = await params
  const [recipe, pricing] = await Promise.all([
    getRecipe(recipeId),
    getPricingEntries(),
  ])
  if (!recipe) notFound()
  // The tab is hidden for anyone who cannot see cost; the URL is closed too.
  if (!recipe.canViewCost) notFound()
  const identities = pricing.items
  const lines = recipe.items
    .filter((item) => item.kind === "ingredient" || item.kind === "subrecipe")
    .map((item) => ({
      itemId: item.id,
      kind:
        item.kind === "subrecipe"
          ? ("subrecipe" as const)
          : ("ingredient" as const),
      quantity: item.quantity,
      unit: item.unit,
      displayName: item.displayName,
      excludedFromCost: item.excludedFromCost,
      targetId: item.ingredientId ?? item.subrecipeId,
      costCents: item.costCents,
    }))
  // The step's own labor, and the prep time as the seconds the costing wants.
  const steps = recipe.steps.map((step) => ({
    laborKind: step.laborKind,
    timings: step.timings.map((timing) => ({ seconds: timing.seconds })),
  }))
  const prepTimeSeconds = recipePrepTimeSeconds(recipe)
  const unit = recipe.yieldUnit as YieldUnit | null
  const recipeYield =
    recipe.yieldAmount != null && unit && YIELD_UNITS.includes(unit)
      ? { amount: recipe.yieldAmount, unit }
      : null

  return (
    <RecipeCostView
      recipeId={recipe.id}
      recipePublicId={recipe.publicId}
      canEditCosting={recipe.permission === "owner"}
      lines={lines}
      recipeYield={recipeYield}
      equivalency={recipe.equivalency}
      servingAmount={recipe.servingAmount ?? null}
      servingUnit={recipe.servingUnit ?? ""}
      menuPriceCents={recipe.menuPriceCents}
      steps={steps}
      prepTimeSeconds={prepTimeSeconds}
      autoPrepTimeEnabled={recipe.autoPrepTimeEnabled ?? false}
      priceList={identities}
    />
  )
}
