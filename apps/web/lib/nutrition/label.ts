import type { z } from "zod"

import type {
  NutrientKey,
  nutritionCompositionSchema,
} from "@/lib/backend/schemas"
import type { Nutrients } from "@/lib/backend/types"
import {
  ALLERGENS,
  EU_DECLARED,
  US_DECLARED,
  allergenLabel,
  declaredAllergenKeys,
  type AllergenKey,
} from "@/lib/nutrition/allergens"
import { generalEnergyKcal } from "@/lib/recipe/nutrition"

/**
 * Rounding, %DV and EU formatting over the `{amount, complete}` values the
 * backend rollup returns. Nothing here sums a recipe: the Python engine is the
 * only rollup, and this module only decides how a figure reads on a label.
 */

type NutrientValue = { amount: number; complete: boolean }
export type LabelFormat = "us" | "eu"

type Composition = z.infer<typeof nutritionCompositionSchema>

export const NUTRIENT_LABELS: Record<NutrientKey, string> = {
  calories: "Calories",
  energyKj: "Energy",
  fat: "Total fat",
  saturatedFat: "Saturated fat",
  transFat: "Trans fat",
  cholesterolMg: "Cholesterol",
  sodiumMg: "Sodium",
  salt: "Salt",
  totalCarbohydrate: "Total carbohydrate",
  fiber: "Dietary fiber",
  sugars: "Total sugars",
  addedSugars: "Added sugars",
  protein: "Protein",
  vitaminDMcg: "Vitamin D",
  calciumMg: "Calcium",
  ironMg: "Iron",
  potassiumMg: "Potassium",
}

/** The nutrients a format's panel cannot leave out. */
export const US_MANDATORY: readonly NutrientKey[] = [
  "calories",
  "fat",
  "saturatedFat",
  "transFat",
  "cholesterolMg",
  "sodiumMg",
  "totalCarbohydrate",
  "fiber",
  "sugars",
  "addedSugars",
  "protein",
  "vitaminDMcg",
  "calciumMg",
  "ironMg",
  "potassiumMg",
]

export const EU_MANDATORY: readonly NutrientKey[] = [
  "energyKj",
  "calories",
  "fat",
  "saturatedFat",
  "totalCarbohydrate",
  "sugars",
  "protein",
  "salt",
]

/** Mandatory nutrients no linked record reports, in label order. */
export function missingNutrients(
  values: Nutrients,
  format: LabelFormat
): NutrientKey[] {
  const mandatory = format === "us" ? US_MANDATORY : EU_MANDATORY
  return mandatory.filter((key) => !values[key].complete)
}

/** The FDA daily values a %DV column divides by. Protein has none. */
export const DAILY_VALUES = {
  fat: 78,
  saturatedFat: 20,
  cholesterolMg: 300,
  sodiumMg: 2300,
  totalCarbohydrate: 275,
  fiber: 28,
  addedSugars: 50,
  vitaminDMcg: 20,
  calciumMg: 1300,
  ironMg: 18,
  potassiumMg: 4700,
} as const

const KJ_PER_KCAL = 4.184

/** Multiplies every amount; completeness travels with it. */
export function scaleNutrients(values: Nutrients, factor: number): Nutrients {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { amount: value.amount * factor, complete: value.complete },
    ])
  ) as Nutrients
}

/**
 * An ingredient's own per-100 g snapshot as label values, for the preview on
 * its Nutrition tab. A key the record does not report is unknown, never zero,
 * except where the contract derives it: carbohydrate from its parts, sodium
 * from salt, and energy from the macros when the record states none.
 */
export function nutrientsFromComposition(
  per100g: Composition,
  options: { sugarsAreAdded?: boolean } = {}
): Nutrients {
  const known = (value: number | null | undefined): NutrientValue =>
    value === null || value === undefined
      ? { amount: 0, complete: false }
      : { amount: value, complete: true }
  const totalCarbohydrate =
    per100g.totalCarbohydrate ?? per100g.sugars + per100g.starch + per100g.fiber
  const sodiumMg = per100g.sodiumMg ?? (per100g.salt / 2.5) * 1000
  const calories =
    per100g.calories ??
    generalEnergyKcal({
      protein: per100g.protein,
      carbohydrate: Math.max(0, totalCarbohydrate - per100g.fiber),
      fat: per100g.fat,
      fiber: per100g.fiber,
    })
  const sugars = known(per100g.sugars)
  return {
    calories: { amount: calories, complete: true },
    energyKj: { amount: calories * KJ_PER_KCAL, complete: true },
    fat: known(per100g.fat),
    saturatedFat: known(per100g.saturatedFat),
    transFat: known(per100g.transFat),
    cholesterolMg: known(per100g.cholesterolMg),
    sodiumMg: { amount: sodiumMg, complete: true },
    salt: known(per100g.salt),
    totalCarbohydrate: { amount: totalCarbohydrate, complete: true },
    fiber: known(per100g.fiber),
    sugars,
    addedSugars: options.sugarsAreAdded ? sugars : known(per100g.addedSugars),
    protein: known(per100g.protein),
    vitaminDMcg: known(per100g.vitaminDMcg),
    calciumMg: known(per100g.calciumMg),
    ironMg: known(per100g.ironMg),
    potassiumMg: known(per100g.potassiumMg),
  }
}

/** Rounds to a step and trims the float noise the step leaves behind. */
function snap(value: number, step: number): number {
  const decimals = step < 1 ? (String(step).split(".")[1]?.length ?? 0) : 0
  return Number((Math.round(value / step) * step).toFixed(decimals))
}

/* ------------------------------- US rounding ------------------------------ */

/** Below 5 reads 0; to 50 the nearest 5; above that the nearest 10. */
export function roundCalories(kcal: number): number {
  if (kcal < 5) return 0
  if (kcal <= 50) return snap(kcal, 5)
  return snap(kcal, 10)
}

/** Fat, saturates and trans fat: below 0.5 reads 0; to 5 the nearest half gram. */
export function roundFatGrams(grams: number): string {
  if (grams < 0.5) return "0"
  if (grams < 5) return String(snap(grams, 0.5))
  return String(snap(grams, 1))
}

/** Below 2 reads 0; 2 to 5 reads "less than 5"; above that the nearest 5. */
export function roundCholesterol(mg: number): string {
  if (mg < 2) return "0"
  if (mg <= 5) return "less than 5"
  return String(snap(mg, 5))
}

/** Below 5 reads 0; to 140 the nearest 5; above that the nearest 10. */
export function roundSodium(mg: number): string {
  if (mg < 5) return "0"
  if (mg <= 140) return String(snap(mg, 5))
  return String(snap(mg, 10))
}

/** Carbohydrate, fiber, sugars and protein: below 0.5 reads 0; below 1 reads "less than 1". */
export function roundCarbGrams(grams: number): string {
  if (grams < 0.5) return "0"
  if (grams < 1) return "less than 1"
  return String(snap(grams, 1))
}

export function roundVitaminD(mcg: number): string {
  return String(snap(mcg, 0.1))
}

export function roundIron(mg: number): string {
  return String(snap(mg, 0.1))
}

/** Calcium and potassium print to the nearest 10 mg. */
export function roundMineral10(mg: number): string {
  return String(snap(mg, 10))
}

/**
 * The %DV column, from the unrounded amount. Macros round to the nearest
 * whole percent; vitamins and minerals step by 2 to 10%, by 5 to 50%, and by
 * 10 beyond that.
 */
export function percentDailyValue(
  amount: number,
  dailyValue: number,
  kind: "macro" | "micro"
): number {
  const percent = (amount / dailyValue) * 100
  if (kind === "macro") return snap(percent, 1)
  if (percent <= 10) return snap(percent, 2)
  if (percent <= 50) return snap(percent, 5)
  return snap(percent, 10)
}

export type LabelRow = {
  key: NutrientKey
  label: string
  amount: string
  unit: "g" | "mg" | "mcg"
  percent: number | null
  /** 0 is a main row, 1 sits under it, 2 is the added sugars line. */
  indent: 0 | 1 | 2
}

type UsRowSpec = {
  key: NutrientKey
  label: string
  unit: LabelRow["unit"]
  round: (amount: number) => string
  dailyValue: number | null
  indent: LabelRow["indent"]
}

const US_ROWS: UsRowSpec[] = [
  {
    key: "fat",
    label: "Total Fat",
    unit: "g",
    round: roundFatGrams,
    dailyValue: DAILY_VALUES.fat,
    indent: 0,
  },
  {
    key: "saturatedFat",
    label: "Saturated Fat",
    unit: "g",
    round: roundFatGrams,
    dailyValue: DAILY_VALUES.saturatedFat,
    indent: 1,
  },
  {
    key: "transFat",
    label: "Trans Fat",
    unit: "g",
    round: roundFatGrams,
    dailyValue: null,
    indent: 1,
  },
  {
    key: "cholesterolMg",
    label: "Cholesterol",
    unit: "mg",
    round: roundCholesterol,
    dailyValue: DAILY_VALUES.cholesterolMg,
    indent: 0,
  },
  {
    key: "sodiumMg",
    label: "Sodium",
    unit: "mg",
    round: roundSodium,
    dailyValue: DAILY_VALUES.sodiumMg,
    indent: 0,
  },
  {
    key: "totalCarbohydrate",
    label: "Total Carbohydrate",
    unit: "g",
    round: roundCarbGrams,
    dailyValue: DAILY_VALUES.totalCarbohydrate,
    indent: 0,
  },
  {
    key: "fiber",
    label: "Dietary Fiber",
    unit: "g",
    round: roundCarbGrams,
    dailyValue: DAILY_VALUES.fiber,
    indent: 1,
  },
  {
    key: "sugars",
    label: "Total Sugars",
    unit: "g",
    round: roundCarbGrams,
    dailyValue: null,
    indent: 1,
  },
  {
    key: "addedSugars",
    label: "Added Sugars",
    unit: "g",
    round: roundCarbGrams,
    dailyValue: DAILY_VALUES.addedSugars,
    indent: 2,
  },
  {
    key: "protein",
    label: "Protein",
    unit: "g",
    round: roundCarbGrams,
    dailyValue: null,
    indent: 0,
  },
]

const US_VITAMINS: UsRowSpec[] = [
  {
    key: "vitaminDMcg",
    label: "Vitamin D",
    unit: "mcg",
    round: roundVitaminD,
    dailyValue: DAILY_VALUES.vitaminDMcg,
    indent: 0,
  },
  {
    key: "calciumMg",
    label: "Calcium",
    unit: "mg",
    round: roundMineral10,
    dailyValue: DAILY_VALUES.calciumMg,
    indent: 0,
  },
  {
    key: "ironMg",
    label: "Iron",
    unit: "mg",
    round: roundIron,
    dailyValue: DAILY_VALUES.ironMg,
    indent: 0,
  },
  {
    key: "potassiumMg",
    label: "Potassium",
    unit: "mg",
    round: roundMineral10,
    dailyValue: DAILY_VALUES.potassiumMg,
    indent: 0,
  },
]

function usRow(spec: UsRowSpec, values: Nutrients, kind: "macro" | "micro") {
  const value = values[spec.key]
  return {
    key: spec.key,
    label: spec.label,
    amount: spec.round(value.amount),
    unit: spec.unit,
    percent:
      spec.dailyValue === null
        ? null
        : percentDailyValue(value.amount, spec.dailyValue, kind),
    indent: spec.indent,
  } satisfies LabelRow
}

/**
 * The FDA panel's rows, in its order, from one serving's values. A nutrient
 * not every record reports prints the sum of what is known, the way a label
 * prints any figure; the note under the label, not the panel, says which.
 */
export function formatUsRows(perServing: Nutrients): {
  calories: string
  rows: LabelRow[]
  vitamins: LabelRow[]
} {
  return {
    calories: String(roundCalories(perServing.calories.amount)),
    rows: US_ROWS.map((spec) => usRow(spec, perServing, "macro")),
    vitamins: US_VITAMINS.map((spec) => usRow(spec, perServing, "micro")),
  }
}

/* ------------------------------- EU rounding ------------------------------ */

/** 10 g and up to the nearest gram; 0.5 g and up to a tenth; less reads "<0.5". */
export function roundEuGrams(grams: number): string {
  if (grams >= 10) return String(snap(grams, 1))
  if (grams >= 0.5) return String(snap(grams, 0.1))
  return "<0.5"
}

/** Salt: 1 g and up to a tenth; 0.0125 g and up to a hundredth; less reads "<0.01". */
export function roundEuSalt(grams: number): string {
  if (grams >= 1) return String(snap(grams, 0.1))
  if (grams >= 0.0125) return String(snap(grams, 0.01))
  return "<0.01"
}

export type EuRow = {
  key: NutrientKey
  label: string
  per100g: string
  perServing: string | null
  indent: boolean
}

/** "1046 kJ / 250 kcal", from the payload's own kilojoules. */
function euEnergy(values: Nutrients): string {
  return `${Math.round(values.energyKj.amount)} kJ / ${Math.round(values.calories.amount)} kcal`
}

const EU_ROWS: {
  key: NutrientKey
  label: string
  indent: boolean
  cell: (values: Nutrients) => string
}[] = [
  {
    key: "energyKj",
    label: "Energy",
    indent: false,
    cell: euEnergy,
  },
  {
    key: "fat",
    label: "Fat",
    indent: false,
    cell: (v) => `${roundEuGrams(v.fat.amount)} g`,
  },
  {
    key: "saturatedFat",
    label: "of which saturates",
    indent: true,
    cell: (v) => `${roundEuGrams(v.saturatedFat.amount)} g`,
  },
  {
    key: "totalCarbohydrate",
    label: "Carbohydrate",
    indent: false,
    cell: (v) => `${roundEuGrams(v.totalCarbohydrate.amount)} g`,
  },
  {
    key: "sugars",
    label: "of which sugars",
    indent: true,
    cell: (v) => `${roundEuGrams(v.sugars.amount)} g`,
  },
  {
    key: "protein",
    label: "Protein",
    indent: false,
    cell: (v) => `${roundEuGrams(v.protein.amount)} g`,
  },
  {
    key: "salt",
    label: "Salt",
    indent: false,
    cell: (v) => `${roundEuSalt(v.salt.amount)} g`,
  },
]

/** The EU table, per 100 g and, when the serving is known, per serving. */
export function formatEuRows(
  per100g: Nutrients,
  perServing: Nutrients | null
): EuRow[] {
  return EU_ROWS.map((row) => ({
    key: row.key,
    label: row.label,
    per100g: row.cell(per100g),
    perServing: perServing ? row.cell(perServing) : null,
    indent: row.indent,
  }))
}

/* -------------------------------- Allergens ------------------------------- */

/**
 * Splits kitchen tags into the ones the format's CONTAINS line declares and
 * the rest, as labels in the tag order. Nothing here is a regulated
 * declaration: species naming and thresholds are out of scope.
 */
/** A tag a format leaves off says nothing new when one it declares already
 * covers it: wheat is the gluten cereal a US label names. */
const COVERED_BY: Record<string, readonly string[]> = {
  gluten_cereals: ["wheat"],
}

export function declaredAllergens(
  keys: readonly string[],
  format: LabelFormat
): { declared: string[]; kitchen: string[] } {
  const declaredSet = format === "us" ? US_DECLARED : EU_DECLARED
  const present = new Set(keys)
  const declared: string[] = []
  const kitchen: string[] = []
  for (const entry of ALLERGENS) {
    if (!present.has(entry.key)) continue
    if (declaredSet.has(entry.key as AllergenKey)) declared.push(entry.label)
    else if (
      !(COVERED_BY[entry.key] ?? []).some(
        (cover) => present.has(cover) && declaredSet.has(cover as AllergenKey)
      )
    )
      kitchen.push(entry.label)
  }
  for (const key of keys) {
    if (!ALLERGENS.some((entry) => entry.key === key))
      kitchen.push(allergenLabel(key))
  }
  return { declared, kitchen }
}

/** Tags a real label has to spell out by species. */
export const SPECIES_KEYS: ReadonlySet<string> = new Set([
  "tree_nuts",
  "fish",
  "shellfish",
])

/** One ingredient statement entry, with the tags its ingredient contains. */
export type StatementEntry = {
  name: string
  grams: number
  allergens: readonly string[]
}

export type StatementRun = { name: string; emphasised: boolean }

/**
 * The ingredient list in one case, the way a package prints it. An entry
 * carrying a tag the region declares is emphasised on an EU/UK label, where
 * the emphasis is the declaration; a US label declares on its CONTAINS line
 * instead, so its list carries none.
 */
export function statementRuns(
  entries: readonly StatementEntry[],
  region: LabelFormat
): StatementRun[] {
  const declared = declaredAllergenKeys(region)
  return entries.map((entry) => ({
    name: statementName(entry.name),
    emphasised:
      region === "eu" &&
      entry.allergens.some((key) => declared.has(key as AllergenKey)),
  }))
}

/** Pantry names arrive in whatever casing the kitchen typed; the list prints
 * them all in lower case. */
function statementName(name: string): string {
  return name.toLowerCase()
}

export type ContainsLine = {
  /** The CONTAINS groups, species-named where an entry names the kind. */
  groups: string[]
  /** A species group is declared and no entry names its kind. */
  unnamedSpecies: boolean
}

/**
 * The US CONTAINS line: one group per declared tag, and for tree nuts, fish
 * and crustacean shellfish the kinds the statement names. An EU label has no
 * CONTAINS line when an ingredient list is present, so the groups are empty
 * there and the emphasised list is the declaration.
 */
export function containsLine(
  entries: readonly StatementEntry[],
  containsKeys: readonly string[],
  region: LabelFormat
): ContainsLine {
  const declared = declaredAllergenKeys(region)
  const present = new Set(containsKeys)
  const groups: string[] = []
  let unnamedSpecies = false
  for (const entry of ALLERGENS) {
    if (!present.has(entry.key)) continue
    if (!declared.has(entry.key)) continue
    const kinds = SPECIES_KEYS.has(entry.key)
      ? entries
          .filter((item) => item.allergens.includes(entry.key))
          .map((item) => statementName(item.name))
      : []
    if (SPECIES_KEYS.has(entry.key) && kinds.length === 0) unnamedSpecies = true
    groups.push(
      kinds.length > 0 ? `${entry.label} (${kinds.join(", ")})` : entry.label
    )
  }
  return { groups: region === "eu" ? [] : groups, unnamedSpecies }
}

/**
 * Servings per container the way 21 CFR 101.9(b)(8) prints it: a whole number,
 * or the nearest half between 2 and 5, with "about" whenever rounding moved it.
 */
export function formatServings(count: number): string {
  const rounded = roundServings(count)
  const text = formatAmount(rounded)
  return Math.abs(rounded - count) < 0.001 ? text : `about ${text}`
}

function roundServings(count: number): number {
  return count >= 2 && count <= 5
    ? Math.round(count * 2) / 2
    : Math.round(count)
}

/** The panel's first line, singular when the container holds one serving. */
export function servingsPerContainer(count: number): string {
  const noun = roundServings(count) === 1 ? "serving" : "servings"
  return `${formatServings(count)} ${noun} per container`
}

export function formatAmount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    value
  )
}
