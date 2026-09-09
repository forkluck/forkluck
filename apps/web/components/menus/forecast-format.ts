import type { MenuForecast } from "@/lib/backend/types"
import type { MeasurementSystem } from "@/lib/business-settings"
import { unitDefinition, unitShort } from "@/lib/unit-registry"
import {
  displayWeight,
  toGrams,
  WEIGHT_UNITS,
  type WeightUnit,
} from "@/lib/units"

/**
 * How the forecast's physical figures read, shared by the tables on screen
 * and the lists a kitchen takes away. Kept out of the components so the
 * export and the table cannot drift apart.
 */

type MaterialRow = MenuForecast["materialRequirements"][number]
type RecipeRow = MenuForecast["recipeRequirements"][number]
type Quantity = { quantity: number; unit: string }

/**
 * Three digits a kitchen can act on: 981 g, 12.3 kg, 1.23 kg. Past a hundred a
 * fraction is noise on a forecast that is only good to a tenth or so of its
 * total, and the backend's thousandths never reach the screen.
 */
const amountFormats = [0, 1, 2].map(
  (digits) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits })
)

export function amount(value: number) {
  return amountFormats[value >= 100 ? 0 : value >= 10 ? 1 : 2].format(value)
}

/** Pieces, eggs, cases: a count, which the kitchen cannot buy a fraction of. */
export function isCountUnit(unit: string) {
  return unitDefinition(unit)?.family === "count"
}

/** A pinch or a dash: a gesture, which no shopping list can add up. */
export function isApproximateUnit(unit: string) {
  return unitDefinition(unit)?.approximate === true
}

/**
 * A weight in the kitchen's own system, stepping up to the larger unit once
 * it gets there: 1,234 g reads 1.23 kg, and a thousand millilitres a litre.
 * Cups, cases and pieces are shown as they stand, except that a count is
 * whole: nobody buys 48.7 eggs.
 */
export function measure(
  quantity: number,
  unit: string,
  system: MeasurementSystem
) {
  if (WEIGHT_UNITS.includes(unit as WeightUnit)) {
    const display = displayWeight(toGrams(quantity, unit as WeightUnit), system)
    return `${amount(display.amount)} ${display.unit}`
  }
  if (unit === "ml" || unit === "l") {
    const millilitres = unit === "l" ? quantity * 1000 : quantity
    const litres = millilitres >= 1000
    return `${amount(litres ? millilitres / 1000 : millilitres)} ${unitShort(litres ? "l" : "ml")}`
  }
  const shown = isCountUnit(unit) ? Math.ceil(quantity) : quantity
  return `${amount(shown)} ${unitShort(unit) || unit}`
}

export function quantities(rows: Quantity[], system: MeasurementSystem) {
  if (!rows.length) return "—"
  return rows.map((row) => measure(row.quantity, row.unit, system)).join(", ")
}

/**
 * What the horizon needs of a material, in the unit it is bought in. A row
 * whose purchase side is unresolved (no pack, no conversion) falls back to
 * its recipe usage, so the cook still sees a figure while the row is fixed.
 */
export function needed(row: MaterialRow, system: MeasurementSystem) {
  return quantities(row.purchase.length ? row.purchase : row.usage, system)
}

/**
 * The recipe-side figures worth a second line: usage in more than one unit,
 * or in a unit no scale reads. "27 ea, 369 g" of egg yolk is two recipes
 * measuring the same thing two ways, and the cook should see both.
 */
export function usageNote(row: MaterialRow, system: MeasurementSystem) {
  if (!row.purchase.length) return null
  const mixed =
    row.usage.length > 1 ||
    row.usage.some((line) => isApproximateUnit(line.unit))
  return mixed ? `from ${quantities(row.usage, system)}` : null
}

/** Whole packs to buy; the kitchen orders 5, not 4.8. */
export function packsToBuy(packs: number | null) {
  return packs === null ? null : Math.max(1, Math.ceil(packs - 1e-9))
}

export function packsLabel(packs: number) {
  return packs === 1 ? "1 pack" : `${amount(packs)} packs`
}

/** What the batches make, in the recipe's yield unit; null without a yield. */
export function makes(row: RecipeRow): Quantity | null {
  if (row.yieldAmount === null || !row.yieldUnit) return null
  return { quantity: row.batches * row.yieldAmount, unit: row.yieldUnit }
}
