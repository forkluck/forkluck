import vocabulary from "../../../data/parser-vocabulary.json"

export type WeightUnit = "g" | "kg" | "oz" | "lb"

export const WEIGHT_UNITS: WeightUnit[] = ["g", "kg", "oz", "lb"]

/** Grams in one of each display weight unit, from the shared unit catalog. */
export const GRAMS_PER_UNIT: Record<WeightUnit, number> = Object.fromEntries(
  vocabulary.units
    .filter((unit) => WEIGHT_UNITS.includes(unit.slug as WeightUnit))
    .map((unit) => [unit.slug, unit.perBase as number])
) as Record<WeightUnit, number>

export function toGrams(amount: number, unit: WeightUnit): number {
  return amount * GRAMS_PER_UNIT[unit]
}

export function fromGrams(grams: number, unit: WeightUnit): number {
  return grams / GRAMS_PER_UNIT[unit]
}

export type WeightSystem = "metric" | "us"

export function weightUnitSystem(unit: WeightUnit): WeightSystem {
  return unit === "g" || unit === "kg" ? "metric" : "us"
}

export function displayWeight(
  grams: number,
  system: WeightSystem
): { amount: number; unit: WeightUnit } {
  const unit: WeightUnit =
    system === "metric"
      ? grams >= GRAMS_PER_UNIT.kg
        ? "kg"
        : "g"
      : grams >= GRAMS_PER_UNIT.lb
        ? "lb"
        : "oz"
  return { amount: fromGrams(grams, unit), unit }
}

export function weightInputFromGrams(
  grams: number,
  system: WeightSystem
): { amount: string; unit: WeightUnit } {
  const display = displayWeight(grams, system)
  return {
    amount: String(Number(display.amount.toFixed(6))),
    unit: display.unit,
  }
}

export function formatWeight(
  grams: number,
  system: WeightSystem,
  original?: { amount: number | null; unit: string | null }
): string {
  const originalUnit = original?.unit as WeightUnit | null | undefined
  const useOriginal =
    original?.amount !== null &&
    original?.amount !== undefined &&
    originalUnit !== null &&
    originalUnit !== undefined &&
    WEIGHT_UNITS.includes(originalUnit) &&
    weightUnitSystem(originalUnit) === system
  const display = useOriginal
    ? { amount: original.amount as number, unit: originalUnit }
    : displayWeight(grams, system)
  const maximumFractionDigits =
    display.unit === "g" ? 1 : display.unit === "oz" ? 2 : 3
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(display.amount)} ${display.unit}`
}

export type YieldUnit = "pcs" | "slice" | WeightUnit

export const YIELD_UNITS: YieldUnit[] = ["pcs", "slice", "g", "kg", "oz", "lb"]

/**
 * What each yield unit is called on screen. "pcs" is the stored value — it is
 * in the database, the Zod enum, and Django's validation — so renaming it is a
 * data migration, not a label change. Chefs read "ea", so show that instead.
 */
export const YIELD_UNIT_LABELS: Record<YieldUnit, string> = {
  pcs: "ea",
  slice: "slice",
  g: "g",
  kg: "kg",
  oz: "oz",
  lb: "lb",
}
