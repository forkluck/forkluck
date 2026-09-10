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

const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })

/**
 * A figure a kitchen can weigh out or count: whole grams, millilitres and
 * ounces, whole pieces, and one decimal once the unit steps up to kilograms,
 * pounds or litres. A forecast is only good to a tenth or so of its total,
 * so 200.33 g is 200 g and 8.14 kg is 8.1 kg.
 */
function kitchenAmount(value: number, unit: string) {
  return unit === "g" || unit === "ml" || unit === "oz" || isCountUnit(unit)
    ? amountFormats[0].format(Math.round(value))
    : oneDecimal.format(value)
}

/**
 * A weight in the kitchen's own system, stepping up to the larger unit once
 * it gets there: 1,234 g reads 1.2 kg, and a thousand millilitres a litre.
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
    return `${kitchenAmount(display.amount, display.unit)} ${display.unit}`
  }
  if (unit === "ml" || unit === "l") {
    const millilitres = unit === "l" ? quantity * 1000 : quantity
    const litres = millilitres >= 1000
    const shownUnit = litres ? "l" : "ml"
    return `${kitchenAmount(litres ? millilitres / 1000 : millilitres, shownUnit)} ${unitShort(shownUnit)}`
  }
  const shown = isCountUnit(unit) ? Math.ceil(quantity) : quantity
  return `${kitchenAmount(shown, unit)} ${unitShort(unit) || unit}`
}

/**
 * Batches to make: whole, and rounded up, because a kitchen makes 52 batches
 * to cover 51.5 and never makes half of one. Nothing needed is nothing made.
 */
export function wholeBatches(batches: number) {
  return batches > 0 ? Math.max(1, Math.ceil(batches - 1e-9)) : 0
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

const PLURAL_SHORTS: Record<string, string> = {
  each: "ea",
  dozen: "dz",
  pcs: "pcs",
  box: "boxes",
  bunch: "bunches",
}

/** "3 cases", "2 bags", "88 ea": a count in the unit's own word. */
export function countLabel(quantity: number, unit: string) {
  const short = unitShort(unit) || unit
  if (quantity === 1) return `1 ${short}`
  const plural =
    PLURAL_SHORTS[unit] ?? (short.endsWith("s") ? short : `${short}s`)
  return `${amount(quantity)} ${plural}`
}

/**
 * The pack as the kitchen orders it: the preferred supplier's own words
 * ("24 X 1 LB") when there is one, else the size the ingredient was saved
 * with, as saved. A 4 lb bag is a 4 lb bag on a metric shopping list too.
 */
export function packLabel(row: MaterialRow) {
  if (row.supplierPack)
    return row.supplierPack.rawSize || row.supplierPack.title
  if (row.purchaseSize === null || !row.purchaseUnit) return null
  return `${amount(row.purchaseSize)} ${unitShort(row.purchaseUnit) || row.purchaseUnit}`
}

/**
 * What to order. A material bought by the case or the bag is so many of
 * them; anything else is so many of its pack: "2 × 24 X 1 LB", "3 × 4 qt".
 */
export function buyLabel(row: MaterialRow, packs: number) {
  if (
    !row.supplierPack &&
    row.purchaseSize === 1 &&
    row.purchaseUnit &&
    isCountUnit(row.purchaseUnit)
  ) {
    return countLabel(packs, row.purchaseUnit)
  }
  return `${amount(packs)} × ${packLabel(row) ?? "pack"}`
}

/** What the batches make, in the recipe's yield unit; null without a yield. */
export function makes(row: RecipeRow): Quantity | null {
  if (row.yieldAmount === null || !row.yieldUnit) return null
  return { quantity: row.batches * row.yieldAmount, unit: row.yieldUnit }
}

/** Whole product units, retaining a visible trace of occasional demand. */
export function units(quantity: number) {
  if (quantity > 0 && quantity < 0.5) return "<1"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    quantity
  )
}
