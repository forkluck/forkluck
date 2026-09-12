import { analyzeRecipe, findIngredientProfile } from "./analyze"
import {
  parseRecipeText,
  recipeIngredientBaseName,
  resolveNutritionIngredient,
  resolveRecipeIngredientIdentity,
  type RecipeLineMatch,
} from "./parse"
import { lineIdentity } from "./resolve-line"
import { formatKitchenAmount } from "./scale"
import type { NutritionComposition, RecipeIngredientInput } from "./types"
import { measureIngredientAmount } from "./weigh"
import type { RecipeDetail, RecipeNutrition } from "../backend/types"
import type { PriceListEntry } from "../pricing"
import { convertAmount, unitDefinition } from "../unit-registry"

/**
 * Recipes side by side, the way a baker reads them: every flour line together
 * is 100% and every other line is a share of that. Saved recipes arrive
 * weighed by the server's nutrition read; a pasted recipe is weighed here by
 * the paste parser and the kitchen's own conversions. Both become the same
 * shape, and one pass aligns them by ingredient.
 *
 * Not re-exported from `lib/recipe/index.ts`: `lib/pricing.ts` imports that
 * index, and this module reads pricing's types, so the index would close a
 * cycle. Import it by path.
 */

export const MAX_COMPARE_RECIPES = 4
export const COMPARE_PATH = "/recipes/compare"

export type PercentMode = "bakers" | "weight"

export type FormulaRole =
  | "flour"
  | "liquid"
  | "fat"
  | "sweetener"
  | "egg"
  | "salt"
  | "leavening"
  | "other"

/** The groups a formula reads in, top to bottom. */
export const FORMULA_ROLES: readonly FormulaRole[] = [
  "flour",
  "liquid",
  "fat",
  "sweetener",
  "egg",
  "salt",
  "leavening",
  "other",
]

export const FORMULA_ROLE_LABELS: Record<FormulaRole, string> = {
  flour: "Flour",
  liquid: "Liquids",
  fat: "Fats",
  sweetener: "Sweeteners",
  egg: "Eggs",
  salt: "Salt",
  leavening: "Leavening",
  other: "Other",
}

export type FormulaLineNote = "nonEdible" | "discarded" | null

export type FormulaLineInput = {
  id: string
  /** The line as the recipe writes it. */
  name: string
  /** The pantry's name for it, when the line is linked; what profiles match on. */
  identityName?: string
  /** Null when nothing relates the written amount to a weight. */
  grams: number | null
  /** The written amount, shown beside a line that has no weight: "2 cups". */
  written: string
  /** The line the editor's baker's percentages are stated against. */
  isBase?: boolean
  /** A sub-recipe line: never matched to a built-in profile. */
  isComponent?: boolean
  nutritionPer100g?: NutritionComposition | null
  note?: FormulaLineNote
}

export type FormulaInput = {
  key: string
  title: string
  source: "saved" | "pasted"
  category?: string | null
  href?: string
  lines: FormulaLineInput[]
  /** Pasted lines that looked like ingredients but could not be read. */
  skippedCount?: number
}

export type FormulaOverrides = {
  /** Grams typed on the page for a line, by `gramOverrideKey`. */
  grams: Record<string, number>
  /** A group chosen on the page for a row, by its canonical key. */
  roles: Record<string, FormulaRole>
}

export const NO_OVERRIDES: FormulaOverrides = { grams: {}, roles: {} }

export function gramOverrideKey(formulaKey: string, lineId: string): string {
  return `${formulaKey}:${lineId}`
}

export type FormulaLine = {
  /** Canonical key: the profile when one matches, else the folded name. */
  key: string
  label: string
  role: FormulaRole
  roleOverridden: boolean
  grams: number | null
  gramsOverridden: boolean
  percent: number | null
  /** A profile or a linked record says what is in it. */
  mapped: boolean
  note: FormulaLineNote
  /** The written amount of the first member that has no weight. */
  written: string
  /** The recipe lines merged into this row (one, unless a name repeats). */
  lineIds: string[]
  /** Where grams typed on the page land; null when the row is weighed. */
  unweighedLineId: string | null
  isBase: boolean
  isComponent: boolean
}

export type FormulaBasis = "flour" | "base" | "heaviest" | "total" | "none"

export type FormulaSummary = {
  /** Liquid-role grams as % of flour: hydration as a baker writes it. */
  hydration: number | null
  /** All water as % of flour, milk, eggs and butter included. */
  water: number | null
  fat: number | null
  sugar: number | null
  protein: number | null
  salt: number | null
  unmappedCount: number
  unweighedCount: number
  coveragePercent: number
}

export type Formula = {
  key: string
  title: string
  source: "saved" | "pasted"
  category?: string | null
  href?: string
  lines: FormulaLine[]
  basis: FormulaBasis
  basisGrams: number
  /** What 100% is: "Bread flour + Whole wheat flour", or the one line used. */
  basisLabel: string
  /** Dough weight: every weighed line. */
  totalGrams: number
  totalPercent: number | null
  roleTotals: Record<FormulaRole, { grams: number; percent: number | null }>
  summary: FormulaSummary
  skippedCount: number
}

export type ComparisonTotals = {
  cells: Array<{ grams: number; percent: number | null }>
  /** Percentage points, second minus first; only with exactly two formulas. */
  delta: number | null
}

export type ComparisonRow = {
  key: string
  label: string
  role: FormulaRole
  roleOverridden: boolean
  /** One per formula, null where the formula has no such line. */
  cells: Array<FormulaLine | null>
  delta: number | null
}

export type ComparisonGroup = {
  role: FormulaRole
  label: string
  rows: ComparisonRow[]
  subtotal: ComparisonTotals
}

export type Comparison = {
  mode: PercentMode
  formulas: Formula[]
  /** Only the groups that have a row. */
  groups: ComparisonGroup[]
  total: ComparisonTotals
}

/* ----------------------------------------------------------------------- */
/* URL                                                                      */
/* ----------------------------------------------------------------------- */

/** `?r=a,b,c` as ids: trimmed, distinct, at most the page's cap. */
export function parseCompareIds(raw: string | undefined): string[] {
  if (!raw) return []
  const ids: string[] = []
  for (const part of raw.split(",")) {
    const id = part.trim()
    if (id && !ids.includes(id)) ids.push(id)
    if (ids.length === MAX_COMPARE_RECIPES) break
  }
  return ids
}

export function compareHref(publicIds: string[]): string {
  const ids = parseCompareIds(publicIds.join(","))
  return ids.length ? `${COMPARE_PATH}?r=${ids.join(",")}` : COMPARE_PATH
}

/* ----------------------------------------------------------------------- */
/* Naming and grouping                                                      */
/* ----------------------------------------------------------------------- */

/**
 * The name two recipes' lines meet on. A built-in profile answers first, so
 * "warm water" and "Water" share a row; anything else folds plurals and
 * annotations away and keeps the first spelling seen as its label.
 */
export function canonicalFormulaName(name: string): {
  key: string
  label: string
} {
  const base = recipeIngredientBaseName(name).trim() || name.trim()
  const folded = lineIdentity(base)
  // The profile is asked for the name as written and then for its folded
  // form, so "Whole Eggs" reaches the "Whole egg" profile the way "eggs" does.
  const profile = findIngredientProfile(name) ?? findIngredientProfile(folded)
  if (profile) return { key: `profile:${profile.key}`, label: profile.name }
  return { key: `name:${folded || base.toLowerCase()}`, label: base }
}

const EGG_PROFILES = new Set(["egg", "egg-yolk", "egg-white"])
const LEAVENING_PROFILES = new Set(["instant-yeast", "baking-powder"])

/**
 * Keyword fallbacks for names no profile knows, first match wins. Whole
 * words only, so "buttermilk" is not butter and "salted butter" is not salt.
 * Fat is read before liquid so "cream cheese" lands with the fats.
 */
const ROLE_KEYWORDS: Array<[FormulaRole, RegExp, RegExp | null]> = [
  [
    "leavening",
    /\b(yeast|levain|poolish|biga|sourdough|starter|baking powder|baking soda|bicarbonate|bicarb)\b/,
    null,
  ],
  ["egg", /\b(eggs?|yolks?|egg whites?|albumen)\b/, null],
  ["salt", /\bsalt\b/, null],
  [
    "sweetener",
    /\b(sugar|honey|syrup|molasses|treacle|malt|agave|glucose|dextrose|invert)\b/,
    null,
  ],
  [
    "fat",
    /\b(butter|oil|lard|shortening|ghee|margarine|tallow|cream cheese)\b/,
    null,
  ],
  [
    "liquid",
    /\b(water|milk|buttermilk|cream|juice|beer|stock|broth|yogh?urt|kefir|coffee|espresso|wine)\b/,
    /\b(powder|powdered)\b/,
  ],
  [
    "flour",
    /\b(flour|meal|semolina|cornmeal|starch|cornstarch|farina)\b/,
    null,
  ],
]

function normalizeWords(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** The group a line belongs to: what the profile says, else what its name says. */
export function classifyFormulaRole(
  name: string,
  isComponent = false
): FormulaRole {
  if (isComponent) return "other"
  const profile = findIngredientProfile(name)
  if (profile) {
    if (EGG_PROFILES.has(profile.key)) return "egg"
    if (LEAVENING_PROFILES.has(profile.key)) return "leavening"
    if (profile.role === "hydration") return "liquid"
    if (profile.role !== "other") return profile.role
  }
  const words = normalizeWords(name)
  for (const [role, pattern, unless] of ROLE_KEYWORDS) {
    if (pattern.test(words) && !(unless && unless.test(words))) return role
  }
  return "other"
}

/* ----------------------------------------------------------------------- */
/* One formula                                                              */
/* ----------------------------------------------------------------------- */

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function share(grams: number | null, basisGrams: number): number | null {
  if (grams === null || basisGrams <= 0) return null
  return round((grams / basisGrams) * 100)
}

function emptyRoleTotals(): Formula["roleTotals"] {
  const totals = {} as Formula["roleTotals"]
  for (const role of FORMULA_ROLES) totals[role] = { grams: 0, percent: null }
  return totals
}

type MergedLine = Omit<FormulaLine, "percent"> & {
  identityName: string | undefined
  nutritionPer100g: NutritionComposition | null
}

/** Lines that share a canonical name become one row; a name repeats when a
 * recipe adds the same flour twice. */
function mergeLines(
  input: FormulaInput,
  overrides: FormulaOverrides
): MergedLine[] {
  const rows = new Map<string, MergedLine>()
  for (const line of input.lines) {
    const override = overrides.grams[gramOverrideKey(input.key, line.id)]
    const overridden = override !== undefined && override > 0
    const note = line.note ?? null
    const grams =
      note === "nonEdible" ? null : overridden ? override : line.grams
    const matchName = line.identityName ?? line.name
    const { key, label } = canonicalFormulaName(matchName)
    const isComponent = line.isComponent ?? false
    const existing = rows.get(key)
    if (!existing) {
      const role =
        overrides.roles[key] ?? classifyFormulaRole(matchName, isComponent)
      rows.set(key, {
        key,
        label,
        role,
        roleOverridden: overrides.roles[key] !== undefined,
        grams,
        gramsOverridden: overridden,
        mapped:
          !isComponent &&
          (findIngredientProfile(matchName) !== null ||
            Boolean(line.nutritionPer100g)),
        note,
        written: grams === null && note !== "nonEdible" ? line.written : "",
        lineIds: [line.id],
        unweighedLineId:
          grams === null && note !== "nonEdible" ? line.id : null,
        isBase: line.isBase ?? false,
        isComponent,
        identityName: line.identityName,
        nutritionPer100g: line.nutritionPer100g ?? null,
      })
      continue
    }
    existing.lineIds.push(line.id)
    existing.isBase = existing.isBase || (line.isBase ?? false)
    existing.gramsOverridden = existing.gramsOverridden || overridden
    if (note === "nonEdible") continue
    if (grams === null) {
      // One member without a weight leaves the row without one: a summed
      // part would read as the whole.
      existing.grams = null
      if (existing.unweighedLineId === null) {
        existing.unweighedLineId = line.id
        existing.written = line.written
      }
    } else if (existing.grams !== null) {
      existing.grams += grams
    }
  }
  return [...rows.values()]
}

export function buildFormula(
  input: FormulaInput,
  mode: PercentMode,
  overrides: FormulaOverrides = NO_OVERRIDES
): Formula {
  const merged = mergeLines(input, overrides)
  const weighed = merged.filter(
    (line): line is MergedLine & { grams: number } =>
      line.grams !== null && line.note !== "nonEdible"
  )
  const totalGrams = weighed.reduce((sum, line) => sum + line.grams, 0)
  const flourGrams = weighed
    .filter((line) => line.role === "flour")
    .reduce((sum, line) => sum + line.grams, 0)

  let basis: FormulaBasis = "none"
  let basisGrams = 0
  let basisLabel = ""
  if (mode === "weight") {
    basis = "total"
    basisGrams = totalGrams
    basisLabel = "Total weight"
  } else if (flourGrams > 0) {
    basis = "flour"
    basisGrams = flourGrams
    basisLabel = weighed
      .filter((line) => line.role === "flour")
      .map((line) => line.label)
      .join(" + ")
  } else {
    const base = weighed.find((line) => line.isBase)
    const heaviest = weighed.reduce<(MergedLine & { grams: number }) | null>(
      (best, line) => (!best || line.grams > best.grams ? line : best),
      null
    )
    const chosen = base ?? heaviest
    if (chosen) {
      basis = base ? "base" : "heaviest"
      basisGrams = chosen.grams
      basisLabel = chosen.label
    }
  }

  const lines: FormulaLine[] = merged.map((line) => ({
    key: line.key,
    label: line.label,
    role: line.role,
    roleOverridden: line.roleOverridden,
    grams: line.grams,
    gramsOverridden: line.gramsOverridden,
    percent: share(line.grams, basisGrams),
    mapped: line.mapped,
    note: line.note,
    written: line.written,
    lineIds: line.lineIds,
    unweighedLineId: line.unweighedLineId,
    isBase: line.isBase,
    isComponent: line.isComponent,
  }))

  const roleTotals = emptyRoleTotals()
  for (const line of weighed) roleTotals[line.role].grams += line.grams
  for (const role of FORMULA_ROLES) {
    roleTotals[role].percent = share(roleTotals[role].grams, basisGrams)
  }

  const analysis = analyzeRecipe(
    weighed.map((line): RecipeIngredientInput => ({
      id: line.key,
      name: line.identityName ?? line.label,
      grams: line.grams,
      isComponent: line.isComponent,
      nutritionPer100g: line.nutritionPer100g,
    }))
  )
  const unknown = new Set(analysis.unknownIngredients.map(({ id }) => id))
  for (const line of lines) {
    if (unknown.has(line.key)) line.mapped = false
  }
  const ofFlour = (grams: number) =>
    flourGrams > 0 ? round((grams / flourGrams) * 100) : null
  const summary: FormulaSummary = {
    hydration: ofFlour(roleTotals.liquid.grams),
    water: ofFlour(analysis.waterG),
    fat: ofFlour(analysis.nutritionTotals.fat),
    sugar: ofFlour(analysis.nutritionTotals.sugars),
    protein: ofFlour(analysis.nutritionTotals.protein),
    salt: ofFlour(analysis.nutritionTotals.salt),
    unmappedCount: analysis.unknownIngredients.length,
    unweighedCount: merged.filter(
      (line) => line.grams === null && line.note !== "nonEdible"
    ).length,
    coveragePercent: analysis.coveragePercent,
  }

  return {
    key: input.key,
    title: input.title,
    source: input.source,
    category: input.category,
    href: input.href,
    lines,
    basis,
    basisGrams,
    basisLabel,
    totalGrams: round(totalGrams),
    totalPercent: share(totalGrams, basisGrams),
    roleTotals,
    summary,
    skippedCount: input.skippedCount ?? 0,
  }
}

/* ----------------------------------------------------------------------- */
/* Side by side                                                             */
/* ----------------------------------------------------------------------- */

/**
 * Percentage points between two columns. A column with no such line is at
 * 0%; a column whose line has no weight leaves the difference unknown.
 */
function delta(
  count: number,
  first: number | null | undefined,
  second: number | null | undefined
): number | null {
  if (count !== 2) return null
  const a = first === undefined ? 0 : first
  const b = second === undefined ? 0 : second
  if (a === null || b === null) return null
  return round(b - a)
}

export function compareFormulas(
  inputs: FormulaInput[],
  mode: PercentMode,
  overrides: FormulaOverrides = NO_OVERRIDES
): Comparison {
  const formulas = inputs.map((input) => buildFormula(input, mode, overrides))
  const count = formulas.length
  const groups: ComparisonGroup[] = []
  for (const role of FORMULA_ROLES) {
    const keys: string[] = []
    const labels = new Map<string, string>()
    for (const formula of formulas) {
      for (const line of formula.lines) {
        if (line.role !== role || labels.has(line.key)) continue
        keys.push(line.key)
        labels.set(line.key, line.label)
      }
    }
    if (!keys.length) continue
    const rows = keys.map((key): ComparisonRow => {
      const cells = formulas.map(
        (formula) => formula.lines.find((line) => line.key === key) ?? null
      )
      return {
        key,
        label: labels.get(key) ?? key,
        role,
        roleOverridden: overrides.roles[key] !== undefined,
        cells,
        delta: delta(count, cells[0]?.percent, cells[1]?.percent),
      }
    })
    const subtotalCells = formulas.map((formula) => formula.roleTotals[role])
    groups.push({
      role,
      label: FORMULA_ROLE_LABELS[role],
      rows,
      subtotal: {
        cells: subtotalCells,
        delta: delta(
          count,
          subtotalCells[0]?.percent,
          subtotalCells[1]?.percent
        ),
      },
    })
  }
  const totalCells = formulas.map((formula) => ({
    grams: formula.totalGrams,
    percent: formula.totalPercent,
  }))
  return {
    mode,
    formulas,
    groups,
    total: {
      cells: totalCells,
      delta: delta(count, totalCells[0]?.percent, totalCells[1]?.percent),
    },
  }
}

/* ----------------------------------------------------------------------- */
/* Adapters                                                                 */
/* ----------------------------------------------------------------------- */

/** Grams of a line written in a mass unit, whatever it is linked to. */
function massGrams(quantity: number | null, unit: string): number | null {
  if (quantity === null || quantity <= 0 || !unit) return null
  if (unitDefinition(unit)?.family !== "mass") return null
  return convertAmount(quantity, unit, "g")
}

/**
 * A saved recipe: its rows, weighed by the nutrition read (the same ladder
 * the Nutrition tab climbs), joined by item id for the base mark and the
 * written amount. Headers and notes carry no weight and are left out.
 */
export function savedFormulaInput(
  recipe: RecipeDetail,
  nutrition: RecipeNutrition | null,
  identities: PriceListEntry[]
): FormulaInput {
  const byItem = new Map(
    (nutrition?.lines ?? []).map((line) => [line.itemId, line] as const)
  )
  const lines: FormulaLineInput[] = []
  for (const item of recipe.items) {
    if (item.kind !== "ingredient" && item.kind !== "subrecipe") continue
    const weighed = byItem.get(item.id) ?? null
    const entry = item.ingredientId
      ? identities.find((candidate) => candidate.id === item.ingredientId)
      : undefined
    const nonEdible = weighed?.nonEdible ?? false
    const isComponent = item.kind === "subrecipe"
    const name =
      item.displayName.trim() || item.ingredientName || item.subrecipeName || ""
    lines.push({
      id: item.id,
      name,
      identityName: isComponent
        ? undefined
        : entry?.measureName?.trim() || item.ingredientName || undefined,
      grams: nonEdible
        ? null
        : (weighed?.grams ?? massGrams(item.quantity, item.unit)),
      written:
        item.quantity === null
          ? ""
          : `${formatKitchenAmount(item.quantity)}${item.unit ? ` ${item.unit}` : ""}`,
      isBase: item.isBase,
      isComponent,
      nutritionPer100g: entry?.nutritionPer100g ?? null,
      note: nonEdible
        ? "nonEdible"
        : weighed?.status === "discarded"
          ? "discarded"
          : null,
    })
  }
  // A recipe from before normalized rows keeps its lines as text. Costing
  // still reads that text, so the comparison does too, the way a paste is
  // read; a recipe with rows never falls back to it.
  const legacy = lines.length === 0 && recipe.body.trim()
  return {
    key: recipe.publicId,
    title: recipe.title,
    source: "saved",
    category: recipe.category,
    href: `/recipes/${recipe.publicId}/recipe`,
    lines: legacy ? parsedFormulaLines(recipe.body, identities).lines : lines,
  }
}

function sameFoldedName(left: string, right: string): boolean {
  const identity = lineIdentity(left)
  return identity !== "" && identity === lineIdentity(right)
}

/**
 * A recipe pasted from anywhere. The parser weighs what the text states and
 * what a matched pantry row can convert; a line the exact name lookup misses
 * gets one more chance through the plural-tolerant fold the editor uses
 * ("eggs" reaches "Egg"), and a matched line in cups can still be weighed by
 * the kitchen's own conversion. Whatever stays unweighed keeps its row.
 */
function parsedFormulaLines(
  text: string,
  identities: PriceListEntry[]
): { lines: FormulaLineInput[]; title: string | null; skippedCount: number } {
  const first = parseRecipeText(text, { identities })
  const matches: RecipeLineMatch[] = []
  const matched = new Set<string>()
  for (const line of first.parsedLines) {
    if (line.identityMatched || matched.has(line.ingredientName)) continue
    const candidates = [line.baseName, ...line.identityCandidates]
    const entry = identities.find((candidate) =>
      candidates.some(
        (name) =>
          sameFoldedName(candidate.name, name) ||
          (candidate.measureName
            ? sameFoldedName(candidate.measureName, name)
            : false)
      )
    )
    if (!entry) continue
    matched.add(line.ingredientName)
    matches.push({
      line: line.ingredientName,
      targetId: entry.id,
      targetName: entry.name,
      measureName: entry.measureName,
      targetKind: "ingredient",
    })
  }
  const parsed = matches.length
    ? parseRecipeText(text, { identities, matches })
    : first

  const lines = parsed.parsedLines.map((line): FormulaLineInput => {
    const identity = resolveRecipeIngredientIdentity(
      line.ingredientName,
      identities,
      matches
    )
    const entry = identity
      ? identities.find((candidate) => candidate.id === identity.id)
      : undefined
    const nutrition = resolveNutritionIngredient(
      line.ingredientName,
      identities,
      matches
    )
    let grams = line.ingredient?.grams ?? null
    const unit =
      line.normalizedUnit && line.normalizedUnit !== "assumed-g"
        ? line.normalizedUnit
        : null
    if (grams === null && entry && unit && line.enteredAmount > 0) {
      grams = measureIngredientAmount(
        line.enteredAmount,
        unit,
        entry,
        "mass",
        line.qualifier
      )
    }
    return {
      id: `line-${line.lineNumber}`,
      name: line.baseName.trim() || line.ingredientName,
      identityName: entry ? nutrition.name : undefined,
      grams: grams !== null && grams > 0 ? grams : null,
      written:
        line.enteredAmount > 0
          ? `${formatKitchenAmount(line.enteredAmount)}${line.enteredUnit ? ` ${line.enteredUnit}` : unit ? ` ${unit}` : ""}`
          : "",
      isComponent: nutrition.isComponent,
      nutritionPer100g: nutrition.nutritionPer100g,
    }
  })

  return {
    lines,
    title: parsed.headerLines[0]?.text ?? null,
    skippedCount: parsed.skippedLines.filter(
      (line) => line.kind === "unconvertible"
    ).length,
  }
}

export function pastedFormulaInput(
  key: string,
  title: string,
  text: string,
  identities: PriceListEntry[]
): FormulaInput {
  const parsed = parsedFormulaLines(text, identities)
  return {
    key,
    title: title.trim() || parsed.title || "Pasted recipe",
    source: "pasted",
    lines: parsed.lines,
    skippedCount: parsed.skippedCount,
  }
}
