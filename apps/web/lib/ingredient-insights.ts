import type {
  IngredientPriceRow,
  IngredientRow,
  SupplierItemRow,
} from "./backend/types"
import { centsPerKg, normalizeIngredientName } from "./pricing"

export type DuplicateSuggestion = {
  leftId: string
  leftName: string
  rightId: string
  rightName: string
  reason: string
}

export type IngredientPriceChange = {
  /**
   * Percent change in unit price; positive is a rise. Always compared on unit
   * price, never pack price — switching a 50 lb sack for a 25 lb one moves the
   * pack price without the ingredient itself getting dearer.
   */
  percent: number
  /** The point being compared against, so callers can name the baseline. */
  previous: IngredientPriceRow
}

export function ingredientPriceChange(
  ingredient: IngredientRow
): IngredientPriceChange | null {
  const current = centsPerKg(
    ingredient.purchaseCostCents,
    ingredient.purchaseSize,
    ingredient.purchaseUnit
  )
  // No weight, no price per kilo to compare — a case of eggs moves in price
  // without ever having one.
  if (current === null) return null
  // priceHistory is newest-first, so this is the most recent point at which
  // the unit price was genuinely different.
  const previous = ingredient.priceHistory.find((point) => {
    const historical = centsPerKg(
      point.purchaseCostCents,
      point.purchaseSize,
      point.purchaseUnit
    )
    return historical !== null && Math.abs(historical - current) > 0.01
  })
  if (!previous) return null
  const previousUnitPrice = centsPerKg(
    previous.purchaseCostCents,
    previous.purchaseSize,
    previous.purchaseUnit
  )
  if (previousUnitPrice === null || previousUnitPrice <= 0) return null
  return {
    percent: ((current - previousUnitPrice) / previousUnitPrice) * 100,
    previous,
  }
}

export function cheaperSupplierItem(
  ingredient: IngredientRow
): { item: SupplierItemRow; savingsPercent: number } | null {
  const preferred = ingredient.supplierItems.find((item) => item.isPreferred)
  if (!preferred) return null
  const preferredUnitPrice = centsPerKg(
    preferred.packPriceCents,
    preferred.packAmount,
    preferred.packUnit
  )
  if (preferredUnitPrice === null || preferredUnitPrice <= 0) return null
  const cheaper = ingredient.supplierItems
    .filter((item) => item.id !== preferred.id)
    .map((item) => ({
      item,
      unitPrice: centsPerKg(
        item.packPriceCents,
        item.packAmount,
        item.packUnit
      ),
    }))
    .filter(
      (candidate): candidate is { item: SupplierItemRow; unitPrice: number } =>
        candidate.unitPrice !== null &&
        candidate.unitPrice < preferredUnitPrice * 0.95
    )
    .sort((left, right) => left.unitPrice - right.unitPrice)[0]
  if (!cheaper) return null
  return {
    item: cheaper.item,
    savingsPercent:
      ((preferredUnitPrice - cheaper.unitPrice) / preferredUnitPrice) * 100,
  }
}

export function isIngredientStale(
  ingredient: Pick<IngredientRow, "updatedAt">,
  now: Date = new Date(),
  staleDays = 90
) {
  return now.getTime() - ingredient.updatedAt.getTime() > staleDays * 86_400_000
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length]
}

function duplicateReason(leftName: string, rightName: string): string | null {
  const left = normalizeIngredientName(leftName)
  const right = normalizeIngredientName(rightName)
  if (!left || !right || left === right) return null
  const leftSorted = left.split(" ").sort().join(" ")
  const rightSorted = right.split(" ").sort().join(" ")
  if (leftSorted === rightSorted) return "Same words in a different order"
  const leftNumbers = left.match(/\d+(?:\.\d+)?/g) ?? []
  const rightNumbers = right.match(/\d+(?:\.\d+)?/g) ?? []
  if (leftNumbers.join(",") !== rightNumbers.join(",")) return null
  if (
    Math.min(left.length, right.length) >= 8 &&
    left.split(" ").length === right.split(" ").length &&
    editDistance(left, right) === 1
  ) {
    return "Names differ by one character"
  }
  return null
}

export function findDuplicateIngredients(
  ingredients: Pick<IngredientRow, "id" | "name">[],
  limit = 20
): DuplicateSuggestion[] {
  const suggestions: DuplicateSuggestion[] = []
  for (let leftIndex = 0; leftIndex < ingredients.length; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < ingredients.length;
      rightIndex++
    ) {
      const left = ingredients[leftIndex]
      const right = ingredients[rightIndex]
      const reason = duplicateReason(left.name, right.name)
      if (!reason) continue
      suggestions.push({
        leftId: left.id,
        leftName: left.name,
        rightId: right.id,
        rightName: right.name,
        reason,
      })
      if (suggestions.length >= limit) return suggestions
    }
  }
  return suggestions
}
