import type { PricedLine } from "@/lib/pricing"

import type { ParsedRecipeLine } from "./parse"

/**
 * What a line still needs, in the order the questions actually arise.
 *
 * Knowing *what* something is comes first: until the name lands on something we
 * stock, asking what it costs is premature. `no-conversion` is the honest
 * middle: the ingredient is known and priced, but it was bought in a unit this
 * line does not use and nothing says how the two relate — a case of eggs and a
 * line in grams. That is a question only the kitchen can answer, on the
 * ingredient's conversion or as a preparation.
 */
export type RecipeLineAlert = "not-recognized" | "no-conversion" | "no-price"

export const RECIPE_LINE_ALERT_LABELS: Record<RecipeLineAlert, string> = {
  "not-recognized": "Not in your ingredients",
  "no-conversion": "Not a measurement of this ingredient",
  "no-price": "No price yet",
}

export function recipeLineAlert(
  line: ParsedRecipeLine,
  priced: PricedLine | null
): RecipeLineAlert | null {
  if (!line.identityMatched) return "not-recognized"
  if (priced?.costCents === null || priced?.costCents === undefined) {
    // Recognized and priced, but the units do not meet.
    return priced?.needsConversion ? "no-conversion" : "no-price"
  }
  return null
}

/** What the info icon says when a cost came through a conversion. */
export function costBasisNote(
  priced: PricedLine | null,
  ingredientName: string
): string | null {
  if (!priced || priced.basis === null || priced.basis === "sale-unit") {
    return null
  }
  return priced.basis === "automatic-conversion"
    ? `Costed with the automatic conversion for ${ingredientName}.`
    : `Costed with the conversion set on ${ingredientName}.`
}
