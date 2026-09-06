import {
  WEIGHT_UNITS,
  displayWeight,
  formatWeight,
  toGrams,
  weightUnitSystem,
} from "../units"
import type { WeightSystem, WeightUnit } from "../units"
import { isCountUnit, roundRecipeQuantity } from "./parse"
import type { ParsedRecipeCountUnit, ParsedRecipeLine } from "./parse"

export const MIN_SCALE_FACTOR = 0.001
export const MAX_SCALE_FACTOR = 1000

// Both feed <input type="number"> values, which reject grouped strings.
const scaleFactorFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 3,
  useGrouping: false,
})

// Significant digits, not decimal places: the smallest yield the backend
// accepts (0.000001) at MIN_SCALE_FACTOR is 1e-9, which a six-decimal format
// would display as "0" while the batch scaled it. Fifteen digits is short of
// a double's precision, so float dust from the scale factor still rounds off.
const yieldAmountFormat = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 15,
  useGrouping: false,
})

/** Kitchen fractions worth showing as written: "1/3 tbsp", not "0.333 tbsp". */
const KITCHEN_FRACTIONS: [number, string][] = [
  [1 / 8, "1/8"],
  [1 / 4, "1/4"],
  [1 / 3, "1/3"],
  [3 / 8, "3/8"],
  [1 / 2, "1/2"],
  [5 / 8, "5/8"],
  [2 / 3, "2/3"],
  [3 / 4, "3/4"],
  [7 / 8, "7/8"],
]

const kitchenAmountFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 3,
})

/**
 * A quantity as the recipe stores it: six decimals, trailing zeroes gone. A
 * third of a cup is 0.333333, never the sixteen digits a division produces and
 * the quantity column refuses.
 */
export function clampRecipeQuantity(amount: number | string): string {
  const value = typeof amount === "number" ? amount : Number(amount)
  if (!Number.isFinite(value)) return ""
  return String(roundRecipeQuantity(value))
}

export function formatKitchenAmount(amount: number): string {
  const whole = Math.floor(amount)
  const part = amount - whole
  if (part > 0.001 && part < 0.999) {
    for (const [value, label] of KITCHEN_FRACTIONS) {
      if (Math.abs(part - value) < 0.005) {
        return whole > 0 ? `${whole} ${label}` : label
      }
    }
  }
  return kitchenAmountFormat.format(amount)
}

const eachCountFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
})

const EACH_COUNT_FRACTION_DIGITS = 2

// What formatWeight rounds each display unit to. Mirrored rather than shared:
// that rounding belongs to the editor's tables and the cost summary, which must
// keep it, while only the scaled production view needs to know when a quantity
// has fallen underneath it.
const WEIGHT_FRACTION_DIGITS: Record<WeightUnit, number> = {
  g: 1,
  oz: 2,
  kg: 3,
  lb: 3,
}

// Enough digits to read a pinch off the sheet, whatever its magnitude: a scaled
// batch can push an amount arbitrarily far below its unit's display precision,
// where fixed decimals only ever produce more zeroes.
const subThresholdFormat = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 2,
})

// Half-expand rounding, so anything under half of the last displayed place
// collapses to a zero quantity no matter how the digits are spelled.
function roundsToZero(amount: number, fractionDigits: number): boolean {
  return amount > 0 && amount < 0.5 * 10 ** -fractionDigits
}

/**
 * What formatWeight prints, except that a quantity scaled underneath its
 * display unit's precision keeps significant digits instead of rounding to a
 * zero the batch contradicts. Every weight the scaled view shows goes through
 * here, so a row and the total it belongs to cannot disagree.
 */
export function formatScaledWeight(
  grams: number,
  system: WeightSystem,
  original?: { amount: number; unit: WeightUnit } | null
): string {
  const display =
    original && weightUnitSystem(original.unit) === system
      ? original
      : displayWeight(grams, system)
  if (roundsToZero(display.amount, WEIGHT_FRACTION_DIGITS[display.unit])) {
    return `${subThresholdFormat.format(display.amount)} ${display.unit}`
  }
  return formatWeight(grams, system, original ?? undefined)
}

const weightAmountFormats: Record<WeightUnit, Intl.NumberFormat> =
  Object.fromEntries(
    WEIGHT_UNITS.map((unit) => [
      unit,
      new Intl.NumberFormat("en-US", {
        maximumFractionDigits: WEIGHT_FRACTION_DIGITS[unit],
      }),
    ])
  ) as Record<WeightUnit, Intl.NumberFormat>

/**
 * An amount as a cook reads it off the sheet, without its unit, for a table
 * that keeps the unit in its own column. A weight rounds to what a scale shows
 * — grams to a tenth, ounces to a hundredth — never "8 2/3 g" or "3.226 g",
 * and keeps significant digits when a scaled pinch would otherwise read as
 * zero. A volume or a count keeps its kitchen fraction: "1/3 cup", "2 1/2 ea".
 */
export function formatMeasuredAmount(amount: number, unit: string): string {
  if (!WEIGHT_UNITS.includes(unit as WeightUnit)) {
    return formatKitchenAmount(amount)
  }
  const weightUnit = unit as WeightUnit
  if (roundsToZero(amount, WEIGHT_FRACTION_DIGITS[weightUnit])) {
    return subThresholdFormat.format(amount)
  }
  return weightAmountFormats[weightUnit].format(amount)
}

export type ScaledIngredientLine = {
  lineNumber: number
  name: string
  grams: number
  original: { amount: number; unit: WeightUnit } | null
  /** The scaled household measure as written ("2 cup"), kept beside the
   * resolved weight so the sheet reads in the cook's own units. */
  measure: { amount: number; unit: string } | null
  // The count of discrete items for a count-unit line (each, cans, jars…), so a
  // cook counts them instead of reading a weight; `countUnit` names what is
  // counted. Null for lines measured by weight.
  eachCount: number | null
  countUnit: ParsedRecipeCountUnit | null
  requiresReview: boolean
  isEstimate: boolean
  // Scaled with the line: an unscaled range would bound a batch it isn't from.
  range: { lowGrams: number; highGrams: number } | null
}

// The entered amount may only stand in for the resolved weight when the two
// are the same quantity. An explicit weight written in the recipe, a saved or
// catalog measure — anything that overrides the amount the cook typed —
// resolves to grams the entered amount never named, so the row would otherwise
// print a number the batch total contradicts.
function enteredAmountIsResolvedWeight(
  amount: number,
  unit: WeightUnit,
  grams: number
): boolean {
  return (
    Math.abs(toGrams(amount, unit) - grams) <=
    1e-9 * Math.max(1, Math.abs(grams))
  )
}

export function clampScaleFactor(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.max(value, MIN_SCALE_FACTOR), MAX_SCALE_FACTOR)
}

export function scaleFactorFromYield(
  savedYield: number,
  targetYield: number
): number | null {
  if (!Number.isFinite(savedYield) || savedYield <= 0) return null
  return clampScaleFactor(targetYield / savedYield)
}

export function scaleIngredientLines(
  lines: ParsedRecipeLine[],
  factor: number
): ScaledIngredientLine[] {
  return lines.flatMap((line): ScaledIngredientLine[] => {
    if (line.componentQuantity) {
      return [
        {
          lineNumber: line.lineNumber,
          name: line.ingredientName,
          grams: 0,
          original: null,
          measure: null,
          eachCount: line.componentQuantity.amount * factor,
          countUnit: line.componentQuantity.unit,
          requiresReview: false,
          isEstimate: false,
          range: null,
        },
      ]
    }
    // A line without a resolved weight — or without even a unit to state it in
    // — has nothing to scale; the view lists it separately rather than showing
    // a made-up number.
    if (!line.ingredient || line.normalizedUnit === null) return []
    const normalizedUnit = line.normalizedUnit
    const grams = line.ingredient.grams * factor
    const requiresReview = line.measureRange?.requiresReview ?? false
    const isEstimate = line.resolutionSource === "catalog-measure"
    const range = line.measureRange
      ? {
          lowGrams: line.measureRange.lowGrams * factor,
          highGrams: line.measureRange.highGrams * factor,
        }
      : null

    // Every count unit — each, but also cans, jars, boxes, cloves… — is
    // counted rather than weighed. A weight was resolved so the batch total
    // stays right, but the row shows the entered count so "2 400 g cans" at 2×
    // reads "4 cans", not "1.6 kg".
    if (isCountUnit(normalizedUnit)) {
      return [
        {
          lineNumber: line.lineNumber,
          name: line.ingredient.name,
          grams,
          original: null,
          measure: null,
          eachCount: line.enteredAmount * factor,
          countUnit: normalizedUnit,
          requiresReview,
          isEstimate,
          range,
        },
      ]
    }

    // "assumed-g" means the parser read a bare number as grams, so grams is
    // the unit the entered amount was actually in. Anything else the entered
    // unit cannot be displayed as a weight, so only the gram total is shown.
    const unit: WeightUnit | null =
      normalizedUnit === "assumed-g"
        ? "g"
        : WEIGHT_UNITS.includes(normalizedUnit as WeightUnit)
          ? (normalizedUnit as WeightUnit)
          : null

    const showsEnteredAmount =
      unit !== null &&
      enteredAmountIsResolvedWeight(
        line.enteredAmount,
        unit,
        line.ingredient.grams
      )

    return [
      {
        lineNumber: line.lineNumber,
        name: line.ingredient.name,
        grams,
        original:
          unit && showsEnteredAmount
            ? { amount: line.enteredAmount * factor, unit }
            : null,
        // A non-weight measure (cup, tbsp, ml…) scales alongside its resolved
        // weight so the sheet can show both.
        measure:
          unit === null
            ? {
                amount: line.enteredAmount * factor,
                unit: line.enteredUnit ?? normalizedUnit,
              }
            : null,
        eachCount: null,
        countUnit: null,
        requiresReview,
        isEstimate,
        range,
      },
    ]
  })
}

export function scaledTotalGrams(
  lines: ParsedRecipeLine[],
  factor: number
): number {
  return lines.reduce(
    (total, line) => total + (line.ingredient?.grams ?? 0) * factor,
    0
  )
}

export function formatScaledAmount(
  line: ScaledIngredientLine,
  system: WeightSystem
): string {
  // Count-unit lines carry a real gram weight too, but a cook counts them.
  if (line.eachCount !== null) {
    // A scaled-down line the recipe still needs must never read as none of it.
    const count = roundsToZero(line.eachCount, EACH_COUNT_FRACTION_DIGITS)
      ? subThresholdFormat.format(line.eachCount)
      : eachCountFormat.format(line.eachCount)
    // The label has to agree with the number beside it: a raw 0.999 displays as
    // "1", so the singular is chosen from what the sheet shows, not the count
    // behind it.
    return `${count} ${countUnitLabel(line.countUnit ?? "each", parseDisplayedCount(count))}`
  }

  return formatScaledWeight(line.grams, system, line.original)
}

// The displayed count, read back off the string the cook sees so the label and
// the number cannot disagree. Grouping separators come out first: "1,000"
// parses as 1 otherwise.
function parseDisplayedCount(count: string): number {
  return Number.parseFloat(count.replace(/,/g, ""))
}

/**
 * How a scaled count reads on the sheet. "each" stays the number-agnostic
 * abbreviation "ea"; every other count unit is a real noun the cook counts,
 * singular at a displayed one and plural otherwise (including fractional
 * counts).
 */
function countUnitLabel(unit: ParsedRecipeCountUnit, count: number): string {
  if (unit === "each") return "ea"
  return count === 1 ? unit : pluralizeCountUnit(unit)
}

// The count units are plain English nouns; -es follows the sibilant endings.
function pluralizeCountUnit(unit: string): string {
  return /(?:s|x|ch|sh)$/.test(unit) ? `${unit}es` : `${unit}s`
}

/**
 * A scaled volume in the unit a cook would measure it with: 6 tsp reads as
 * 2 tbsp, 32 tbsp as 2 cups. Only exact multiples change unit, so the number
 * on the sheet is never an approximation of the one in the recipe.
 */
export function tidyVolume(
  amount: number,
  unit: string
): { amount: number; unit: string } {
  const exact = (value: number, per: number) =>
    Math.abs(value / per - Math.round(value / per)) < 0.001
  if (unit === "tsp" && amount >= 3 && exact(amount, 3)) {
    return tidyVolume(Math.round(amount / 3), "tbsp")
  }
  if (unit === "tbsp" && amount >= 16 && exact(amount, 16)) {
    return { amount: Math.round(amount / 16), unit: "cup" }
  }
  return { amount, unit }
}

export function formatScaleFactor(factor: number): string {
  return scaleFactorFormat.format(factor)
}

/**
 * The factor a committed field displays, so the number on screen is the number
 * applied: without this, 0.0014 shows as "0.001" while 0.0014 is what scales.
 */
export function quantizeScaleFactor(factor: number): number {
  return (
    clampScaleFactor(Number.parseFloat(formatScaleFactor(factor))) ?? factor
  )
}

export function formatYieldAmount(amount: number): string {
  return yieldAmountFormat.format(amount)
}

// Wide enough to spell out a factor the yield asked for; float dust still
// rounds off short of a double's precision.
const preciseScaleFactorFormat = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 15,
  useGrouping: false,
})

/**
 * The factor a batch readout shows once it is applied. A factor the yield
 * field derived need not be one formatScaleFactor can spell — showing a
 * rounded "0.002" for the 0.0015 that scales the batch would misread, and a
 * later blur would commit the misreading.
 */
export function formatAppliedScaleFactor(factor: number): string {
  const displayed = formatScaleFactor(factor)
  return Number.parseFloat(displayed) === factor
    ? displayed
    : preciseScaleFactorFormat.format(factor)
}

export type RequestedYieldScale = { factor: number; yieldAmount: number }

/**
 * Committing a typed yield: the yield is the intent, so the factor follows
 * from it without the batch field's rounding and the cook gets back the yield
 * asked for — except where the clamp moved it, which the yield must then show.
 */
export function scaleFromRequestedYield(
  savedYield: number,
  requestedYield: number
): RequestedYieldScale | null {
  const factor = scaleFactorFromYield(savedYield, requestedYield)
  if (factor === null) return null
  return {
    factor,
    yieldAmount:
      factor === requestedYield / savedYield
        ? requestedYield
        : savedYield * factor,
  }
}
