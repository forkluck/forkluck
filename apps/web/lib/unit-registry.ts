import vocabulary from "../../../data/parser-vocabulary.json"

import { WEIGHT_UNITS, displayWeight, toGrams, weightUnitSystem } from "./units"
import type { WeightSystem, WeightUnit } from "./units"

/**
 * One vocabulary of units for the whole app, read from
 * `data/parser-vocabulary.json` so the recipe parser, both pricing engines and
 * Django spell a unit the same way.
 *
 * A unit is identified by its **slug** — `kg`, `fl-oz`, `each`. Labels are for
 * screens only and never for storage or comparison.
 *
 * Mass and volume convert universally. Counts mostly do not: `dozen` is twelve
 * of anything, but a case is 24 of one thing and 36 of another, so a case has no
 * factor here — only the ingredient can say. Those units carry `perBase: null`,
 * which is what makes "one bushel, weight unknown" expressible. A dimensionless
 * unit — a splash, to taste — has no quantity at all and never costs.
 */
export type UnitFamily = "mass" | "volume" | "count" | "dimensionless"

/**
 * Which shelf of the catalog a unit sits on, and so which question it answers.
 * `custom` is the shelf of one: a unit the user typed, on no picker's list.
 */
export type UnitGroup =
  "custom" | "metric" | "cooking" | "pack" | "produce" | "size" | "vague"

export type UnitDefinition = {
  slug: string
  /** The picker's wording, e.g. "Kilogram (kg)". */
  label: string
  /** What a table cell shows, e.g. "kg". */
  short: string
  family: UnitFamily
  /** Base units in one of this: grams, millilitres, or pieces. Null when only
   * the ingredient knows. */
  perBase: number | null
  group: UnitGroup
  /** A gesture rather than a measure — a pinch, a dash. */
  approximate?: boolean
  /** What the recipe parser accepts for this unit, as a regex source. */
  pattern?: string
}

export const UNIT_CATALOG = vocabulary.units as UnitDefinition[]

export const KNOWN_UNITS: Record<string, UnitDefinition> = Object.fromEntries(
  UNIT_CATALOG.map((unit) => [unit.slug, unit])
)

/** The definition for a slug, with a readable fallback for imported data. */
export function unitDefinition(slug: string | null): UnitDefinition | null {
  if (!slug) return null
  const known = KNOWN_UNITS[slug]
  if (known) return known
  return {
    slug,
    label: slug,
    short: slug,
    family: "count",
    perBase: null,
    group: "custom",
  }
}

export function unitLabel(slug: string | null): string {
  return unitDefinition(slug)?.label ?? ""
}

export function unitShort(slug: string | null): string {
  return unitDefinition(slug)?.short ?? ""
}

/**
 * The unit as a sentence says it: "cup", "each", "fluid ounce". Labels carry
 * the abbreviation in brackets for a picker row, and a sentence does not want
 * it, so "Cup (c)" reads back as "cup". Pieces are the yield's own word for a
 * count and the ingredient answers that question in "each".
 */
export function unitWord(slug: string | null): string {
  if (slug === "pcs") return "each"
  const label = unitDefinition(slug)?.label ?? ""
  return label.replace(/\s*\([^)]*\)\s*$/, "").toLocaleLowerCase()
}

/** One row of a unit picker. */
export type UnitOption = {
  slug: string
  label: string
  /** The heading it sits under, set only when a picker spans families. */
  heading?: string
}

const FAMILY_HEADINGS: Record<UnitFamily, string> = {
  mass: "Weight",
  volume: "Volume",
  count: "Count",
  dimensionless: "Other",
}

/**
 * Picker rows drawn from the catalog shelves a question needs, family by
 * family. Mass and volume sort by size ascending, never alphabetically, so a
 * teaspoon sits next to a tablespoon and not next to a ton. Counts have no
 * size to sort by, so they sort by name.
 */
export function unitOptions({
  groups,
  families,
  approximate = true,
}: {
  groups: readonly UnitGroup[]
  families: readonly UnitFamily[]
  approximate?: boolean
}): UnitOption[] {
  const shelves = new Set(groups)
  return families.flatMap((family) =>
    UNIT_CATALOG.filter(
      (unit) =>
        unit.family === family &&
        shelves.has(unit.group) &&
        (approximate || !unit.approximate)
    )
      .sort((a, b) =>
        family === "count"
          ? a.label.localeCompare(b.label)
          : (a.perBase ?? Infinity) - (b.perBase ?? Infinity)
      )
      .map((unit) => ({
        slug: unit.slug,
        label: unit.label,
        ...(families.length > 1 && { heading: FAMILY_HEADINGS[family] }),
      }))
  )
}

const ALL_GROUPS: readonly UnitGroup[] = [
  "metric",
  "cooking",
  "pack",
  "produce",
  "size",
  "vague",
]

/** Every unit a recipe line can be written in, by family, smallest first. */
export function recipeUnitOptions(): UnitOption[] {
  return unitOptions({
    groups: ALL_GROUPS,
    families: ["mass", "volume", "count", "dimensionless"],
  })
}

/** The units a batch is counted, weighed or poured in: no pinches, no mg. */
const YIELD_UNIT_SLUGS = [
  "g",
  "kg",
  "oz",
  "lb",
  "ml",
  "l",
  "fl-oz",
  "cup",
  "pt",
  "qt",
  "gal",
] as const

/**
 * The two spellings a batch is counted in. A crust is "1 pcs" and the tart it
 * lines is "8 slice", and both count what one batch cuts into.
 */
const YIELD_COUNT_SLUGS = ["pcs", "slice"] as const

/** Every slug a Total yield may carry, counts first; the save action checks against it. */
export const YIELD_UNIT_VALUES = [
  ...YIELD_COUNT_SLUGS,
  ...YIELD_UNIT_SLUGS,
] as const

/**
 * "each" for the spellings that count pieces, and the slug itself otherwise.
 *
 * "pcs" is the yield's own word for a count and is not in the catalog; "slice"
 * is in the catalog with no size to convert by. Neither reaches "each" on its
 * own, so this is the one place that says a slice is a piece. It is what lets
 * a slice line and a pieces yield meet: 1 slice of an 8 slice tart is an
 * eighth of that batch, and 1 each of a 1 pcs crust is the whole of that one.
 */
export function countedAsEach(slug: string | null): string | null {
  return slug === "pcs" || slug === "slice" ? "each" : slug
}

/** What a whole recipe makes: counts, then the everyday weights and volumes. */
export function yieldUnitOptions(): UnitOption[] {
  const wanted = new Set<string>(YIELD_UNIT_SLUGS)
  return [
    { slug: "pcs", label: "Pieces (pcs)", heading: FAMILY_HEADINGS.count },
    { slug: "slice", label: "Slice", heading: FAMILY_HEADINGS.count },
    ...recipeUnitOptions().filter((unit) => wanted.has(unit.slug)),
  ]
}

/**
 * What one sold unit of a product is.
 *
 * Curated rather than drawn from a family, because the count family also
 * carries egg grades (large, jumbo) and containers whose contents nobody
 * knows (case, tray), and a menu item is sold by none of them. Mirrors
 * PRODUCT_UNIT_SLUGS in apps/api/forkluck/units.py; the save action checks
 * against that list, and the two are pinned to each other by a parity test.
 */
export const PRODUCT_UNIT_SLUGS = [
  "g",
  "kg",
  "oz",
  "lb",
  "ml",
  "l",
  "fl-oz",
  "each",
  "dozen",
  "slice",
  "portion",
  "serving",
] as const

/** A slug a product may be sold by; the blank default reads as "each". */
export type ProductUnitSlug = (typeof PRODUCT_UNIT_SLUGS)[number]

/** Whether a slug names a unit a product can be sold by. */
export function isProductUnit(slug: string | null): slug is ProductUnitSlug {
  return PRODUCT_UNIT_SLUGS.includes(slug as ProductUnitSlug)
}

/** The rows of the product's unit picker, weights and volumes before counts. */
export function productUnitOptions(): UnitOption[] {
  const wanted = new Set<string>(PRODUCT_UNIT_SLUGS)
  return recipeUnitOptions().filter((unit) => wanted.has(unit.slug))
}

/**
 * The word a product's quantities are counted in. Blank is "each": every
 * product meant that before the unit could be chosen.
 */
export function productUnitWord(slug: string | null | undefined): string {
  return unitWord(slug || "each")
}

/** What a plate holds, beyond a weight or a volume. */
const SERVING_COUNT_SLUGS = ["each", "slice", "portion", "serving"] as const

/**
 * What one serving is: the yield units plus the things a plate holds, and
 * never a clove or a pinch, which belong to the lines.
 */
export function servingUnitOptions(): UnitOption[] {
  const wanted = new Set<string>([...YIELD_UNIT_SLUGS, ...SERVING_COUNT_SLUGS])
  return recipeUnitOptions().filter((unit) => wanted.has(unit.slug))
}

/** Density statements — "1 bunch is 2.8 oz" — measure in the everyday units. */
const DENSITY_GROUPS = ["metric", "cooking"] as const

/**
 * What the ingredient *is*. A pan is where you put it and a can is how it
 * arrived; neither states a density, so neither belongs on these rows.
 */
export function conversionUnitOptions() {
  return {
    weight: unitOptions({
      groups: DENSITY_GROUPS,
      families: ["mass"],
      approximate: false,
    }),
    volume: unitOptions({
      groups: DENSITY_GROUPS,
      families: ["volume"],
      approximate: false,
    }),
    each: unitOptions({ groups: ["produce"], families: ["count"] }),
  }
}

const PURCHASE_UNIT_GROUPS = [
  ["Weight", ["g", "kg", "oz", "lb"]],
  ["Volume", ["ml", "l", "fl-oz", "cup", "pt", "qt", "gal"]],
  [
    "Package",
    [
      "each",
      "dozen",
      "case",
      "pack",
      "bag",
      "box",
      "bottle",
      "can",
      "carton",
      "jar",
      "bunch",
    ],
  ],
] as const

/**
 * The small purchasing vocabulary shown beside Cost. Recipe measures and
 * aliases stay out of this picker: a buyer chooses the readable base unit,
 * then puts the pack quantity in Size.
 */
export function purchaseUnitOptions(): UnitOption[] {
  return PURCHASE_UNIT_GROUPS.flatMap(([heading, slugs]) =>
    slugs.map((slug) => ({ slug, label: KNOWN_UNITS[slug].label, heading }))
  )
}

/** The purchase picker's rows under their headings, each slug carrying its own
 * literal type so a chosen unit goes straight to an import action. */
export function packUnitGroups(): {
  heading: string
  units: { slug: PackUnitSlug; label: string }[]
}[] {
  return PURCHASE_UNIT_GROUPS.map(([heading, slugs]) => ({
    heading,
    units: slugs.map((slug) => ({ slug, label: KNOWN_UNITS[slug].label })),
  }))
}

/**
 * Every slug a purchase or a supplier pack may be stored in — the slugs
 * `purchaseUnitOptions()` offers, written out so both engines can be pinned to
 * one list. Mirrors PACK_UNIT_SLUGS in apps/api/forkluck/units.py, which is
 * what the import actions validate against; a parity test holds the two
 * together.
 */
export const PACK_UNIT_SLUGS = [
  "g",
  "kg",
  "oz",
  "lb",
  "ml",
  "l",
  "fl-oz",
  "cup",
  "pt",
  "qt",
  "gal",
  "each",
  "dozen",
  "case",
  "pack",
  "bag",
  "box",
  "bottle",
  "can",
  "carton",
  "jar",
  "bunch",
] as const

export type PackUnitSlug = (typeof PACK_UNIT_SLUGS)[number]

/** Whether a slug names a unit a pack may be bought in. */
export function isPackUnit(slug: string | null): slug is PackUnitSlug {
  return PACK_UNIT_SLUGS.includes(slug as PackUnitSlug)
}

/**
 * Spellings the catalog has no pattern for. A count column says how many
 * pieces, so it is `each` and a price basis like "EA"; "PK" names a box and
 * only says how many pieces came in it.
 */
const COUNT_WORDS = /^(?:ct|cnt|count)$/
const CONTAINER_WORDS = /^(?:pk|pkg)$/

/**
 * The containers on the purchase list. How much one holds is the ingredient's
 * business, so a printed pack size in cases or bags is a count of pieces and
 * nothing more; the per-piece weight lives in the ingredient's conversions.
 */
const CONTAINER_SLUGS = new Set<string>([
  "case",
  "pack",
  "bag",
  "box",
  "bottle",
  "can",
  "carton",
  "jar",
  "bunch",
])

/**
 * The pack unit a printed word names: "LB" → `lb`, "FL OZ" → `fl-oz`, "CT"
 * and "CS" → `each`. `container` says the word named a box rather than a
 * measure, which is what lets a pack size read "24 each" while a U/M column
 * of "CS" is still no price basis of its own. Mirrors matchPurchaseUnit in
 * components/ingredients/purchase-unit-fields.tsx, which answers the same
 * question for the field a buyer types into.
 */
export function normalizePackUnit(
  word: string
): { slug: PackUnitSlug; container: boolean } | null {
  const typed = word
    .trim()
    .replace(/\.$/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase()
  if (!typed) return null
  // "X" is the multiplication sign in "8 X 1 LB", and the catalog lists it as
  // a spelling of `each`; a size never names its unit with it.
  if (/^[x\u00d7]$/.test(typed)) return null
  if (COUNT_WORDS.test(typed)) return { slug: "each", container: false }
  if (CONTAINER_WORDS.test(typed)) return { slug: "each", container: true }
  const match = PACK_UNIT_SLUGS.find((slug) => {
    const unit = KNOWN_UNITS[slug]
    if (
      [unit.slug, unit.short, unit.label].some(
        (candidate) => candidate.toLocaleLowerCase() === typed
      )
    ) {
      return true
    }
    return unit.pattern
      ? new RegExp(`^(?:${unit.pattern})$`, "i").test(typed)
      : false
  })
  if (!match) return null
  const container = CONTAINER_SLUGS.has(match)
  return { slug: container ? "each" : match, container }
}

/**
 * How many `to` units one `from` unit is, or null when nothing universal
 * relates them — different families, or a container whose contents only the
 * ingredient knows. Null is an answer: it means ask the ingredient.
 */
export function unitRatio(
  from: string | null,
  to: string | null
): number | null {
  const source = unitDefinition(from)
  const target = unitDefinition(to)
  if (!source || !target) return null
  if (source.slug === target.slug) return 1
  if (source.family !== target.family) return null
  if (source.perBase === null || target.perBase === null) return null
  return source.perBase / target.perBase
}

/** `convertAmount(2, "kg", "g")` → 2000; null when the units do not relate. */
export function convertAmount(
  amount: number,
  from: string | null,
  to: string | null
): number | null {
  const ratio = unitRatio(from, to)
  return ratio === null ? null : amount * ratio
}

/**
 * A pack as it was bought: the size and the unit the kitchen entered. A weight
 * is restated in the kitchen's own system; a case or a bushel is not a weight
 * and is shown as it stands.
 */
export function formatPackSize(
  amount: number | null,
  unit: string | null,
  system: WeightSystem
): string {
  if (amount === null || !unit) return "–"
  const weightUnit = unit as WeightUnit
  if (WEIGHT_UNITS.includes(weightUnit)) {
    if (weightUnitSystem(weightUnit) === system) {
      return `${format(amount, weightUnit)} ${weightUnit}`
    }
    const display = displayWeight(toGrams(amount, weightUnit), system)
    return `${format(display.amount, display.unit)} ${display.unit}`
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(amount)} ${unitShort(unit)}`
}

function format(amount: number, unit: WeightUnit): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: unit === "g" ? 1 : unit === "oz" ? 2 : 3,
  }).format(amount)
}
