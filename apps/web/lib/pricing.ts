import {
  analyzeRecipe,
  batchAmountIn,
  parseRecipeText,
  resolveRecipeIngredientIdentity,
  resolveNutritionIngredient,
  conversionPairs,
  type IngredientConversion,
  type IngredientMeasure,
  type ParsedRecipeLine,
  type RecipeLineMatch as ParsedRecipeLineMatch,
  type WeighEquivalency,
} from "./recipe"
import type { RecipeKind } from "./recipe/kinds"
import type { WeightUnit } from "./units"
import { densityGrams } from "./recipe/density"
import {
  convertAmount,
  countedAsEach,
  unitDefinition,
  unitRatio,
} from "./unit-registry"
import { formatCents } from "./money"
import type { NutritionComposition } from "./recipe/types"

export type PriceListEntry = {
  id: string
  name: string
  normalizedName: string
  /** Canonical identity for shared measures when the pantry name is edited. */
  measureName?: string | null
  purchaseCostCents: number
  /** Where the price comes from; pantry when absent. */
  source?: "pantry" | "component" | "master" | "catalog"
  /** Sellable count basis for component recipes declared in pieces. */
  componentYieldAmount?: number | null
  componentYieldUnit?: "pcs" | null
  /** The sale size is the batch's finished weight, not its raw ingredient sum. */
  componentWeightKnown?: boolean
  /** Present only on a narrowly disclosed starter estimate. */
  masterPriceId?: string
  /** Present only on a narrowly disclosed Catalog estimate. */
  catalogPriceId?: string
  purchaseSize?: number | null
  purchaseUnit?: string | null
  /**
   * The usable share of the pack, after trim: a $10 case of tomatoes at 90%
   * costs $11.11 a case of usable tomato. Absent on component, master, catalog
   * and built-in entries, which are already what they cost.
   */
  yieldPercent?: number | null
  /** One equivalence, when the user has said: 227 g of it is 1 cup of it. */
  conversion?: ConversionFields | null
  /**
   * The states this ingredient is used in. A preparation states conversions of
   * its own because a cup of yolks is not a cup of egg; only mass travels from
   * the ingredient to the preparation, through `yieldPercent`. Absent on
   * component, master, catalog and built-in entries.
   */
  preparations?: IngredientPreparation[]
  nutritionPer100g?: NutritionComposition | null
}

/**
 * A preparation states the same six measures an ingredient conversion does,
 * because a cup of yolks is not a cup of egg, so both read the same way.
 */
type ConversionFields = IngredientConversion

type IngredientPreparation = ConversionFields & {
  id: string
  name: string
  yieldPercent: number | null
  /** Where the yield came from. Costing reads the percent the same either way. */
  source?: "user" | "catalog"
}

/**
 * The one comparison key for a written name, in TypeScript.
 *
 * Accents fold away first, so "Crème Fraîche" and "creme fraiche" are the same
 * ingredient however a supplier CSV, an invoice or a chef spelled it. NFKD plus
 * dropping the Mark category is what `forkluck.models.normalized_name` does, in
 * the terms both languages can express exactly; the two must not drift.
 */
export function normalizeIngredientName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/* Search predicates moved to `lib/search.ts`, which is one rule for the whole
 * app and imports the normalizer above. */

/**
 * What one selected weight unit costs, or null when this ingredient has no
 * weight — a case of eggs has a cost but no price per kilo, and saying zero
 * would sort it to the top as the cheapest thing in the pantry.
 */
export function centsPerWeightUnit(
  cents: number,
  size: number | null | undefined,
  sizeUnit: string | null | undefined,
  unit: WeightUnit
): number | null {
  if (!size || size <= 0) return null
  const inUnit = convertAmount(size, sizeUnit ?? null, unit)
  if (inUnit === null || inUnit <= 0) return null
  return cents / inUnit
}

/** The unit price for a screen: an en dash when this thing has no weight. */
export function formatUnitPrice(
  cents: number,
  size: number | null | undefined,
  sizeUnit: string | null | undefined,
  unit: WeightUnit,
  currencyCode: string
): string {
  const perUnit = centsPerWeightUnit(cents, size, sizeUnit, unit)
  return perUnit === null ? "–" : formatCents(perUnit, currencyCode)
}

export function centsPerKg(
  cents: number,
  size: number | null | undefined,
  sizeUnit: string | null | undefined
): number | null {
  return centsPerWeightUnit(cents, size, sizeUnit, "kg")
}

export type RecipeLineMatch = ParsedRecipeLineMatch

/** How a line's cost was reached, so the row can say so. */
export type CostBasis =
  "sale-unit" | "stated-conversion" | "automatic-conversion"

export type PricedLine = {
  name: string
  grams: number | null
  componentQuantity?: { amount: number; unit: "each" } | null
  ingredientId: string | null
  costCents: number | null
  /** Null when the line has no cost. Anything but "sale-unit" earns an icon. */
  basis: CostBasis | null
  needsConversion: boolean
  needsReview: boolean
}

type PriceableLine = {
  name: string
  amount?: number | null
  unit?: string | null
  grams: number | null
  /** True only when the recipe itself stated this weight. */
  gramsAreExplicit?: boolean
  /** The parsed preparation clause, which selects one of the ingredient's. */
  qualifier?: string | null
  /** All written note clauses, used only to select a preparation. */
  preparationNote?: string | null
  componentQuantity?: { amount: number; unit: "each" } | null
  needsReview?: boolean
  /** Out of the money: no cost, and no gap where a cost would be. */
  excluded?: boolean
}

/**
 * How many `to` units one `from` unit is, from the shared weight and volume
 * table — which is what the standard conversion means: a litre of milk weighs
 * what a litre of milk weighs, whoever sells it.
 *
 * Mass into volume only. The other direction already has a better answer: the
 * parser resolves a volume line to grams through the full precedence ladder —
 * explicit weight, saved measure, shared measure, then this chart — and
 * consulting the chart here would put its estimate ahead of all of them. It
 * never turns grams into volume, which is why a volume-bought ingredient had
 * no answer at all. The chart describes the plain ingredient, so a qualified
 * line takes no density, exactly as the parser reads it.
 */
function standardVolumeRatio(
  from: string | null,
  to: string | null,
  entry: PriceListEntry,
  qualifier: string | null
): number | null {
  if (unitDefinition(from)?.family !== "mass") return null
  if (unitDefinition(to)?.family !== "volume") return null
  const grams = unitRatio(from, "g")
  const perMillilitre = densityGrams(
    1,
    "ml",
    entry.measureName?.trim() || entry.name,
    qualifier
  )
  if (grams === null || !perMillilitre || perMillilitre.grams <= 0) return null
  return convertAmount(grams / perMillilitre.grams, "ml", to)
}

/**
 * How many sale units `amount unit` is, and how we worked it out.
 *
 * The unit written on the line is tried first, because that is the answer when
 * it agrees with what was bought: a case of 36 eggs prices "2 each" without a
 * weight existing anywhere. Only a unit that disagrees consults a conversion:
 * the matched preparation's own, when it states one, and the ingredient's
 * otherwise.
 *
 * A preparation that states its own conversion owns the answer, because a cup
 * of yolks is not a cup of egg. One left on the standard conversion — "the
 * pack it is bought as rather than its own row" — states no pairs and borrows
 * the ingredient's. Either way its yield travels: 100 g of minced garlic at
 * 88% yield is 113.6 g of garlic bought, so the sale units go *up*. A line
 * naming no state is costed at the ingredient's own yield instead, never both:
 * 1 lb of tomato off a 90% case is 1.111 lb of case bought.
 *
 * The stated measures are one equivalence, not a description of the pack: 227 g
 * of butter is 1 cup of butter, whether the pack is a 1 lb block or a 25 kg
 * drum. So they answer by relating the line's family to the pack's. The line
 * becomes a share of the measure stated in its own family, that share is taken
 * of the measure stated in the family the pack is bought in, and the pack size
 * divides. A 1 lb block at 227 g a cup prices "1 cup" as 227 g, half a pound,
 * and not as the whole block.
 */
function saleUnitsFor(
  amount: number,
  unit: string | null,
  entry: PriceListEntry,
  preparation: IngredientPreparation | null = null,
  qualifier: string | null = null
): { saleUnits: number; basis: CostBasis } | null {
  const saleUnit = entry.purchaseUnit ?? null
  const saleAmount = entry.purchaseSize ?? null
  if (!saleUnit || saleAmount === null || saleAmount <= 0) return null
  if (!unit || !Number.isFinite(amount)) return null

  // Never both: a line naming a state is costed by that state's yield, and one
  // naming none by the ingredient's own.
  const yieldPercent =
    (preparation ? preparation.yieldPercent : entry.yieldPercent) ?? null
  const yielded = (saleUnits: number): number =>
    yieldPercent !== null && Number.isFinite(yieldPercent) && yieldPercent > 0
      ? (saleUnits * 100) / yieldPercent
      : saleUnits

  const lineUnit = countedAsEach(unit)
  const packUnit = countedAsEach(saleUnit)
  const direct = unitRatio(lineUnit, packUnit)
  if (direct !== null) {
    return {
      saleUnits: yielded((amount * direct) / saleAmount),
      basis: "sale-unit",
    }
  }

  const customPreparation = preparation?.usesStandardConversion === false
  const pairs = customPreparation
    ? conversionPairs(preparation)
    : conversionPairs(entry.conversion)
  if (!pairs.length) {
    // Only when the row is on the standard conversion: stating your own is
    // what the toggle turns the shared table off for.
    if (
      customPreparation ||
      entry.conversion?.usesStandardConversion === false
    ) {
      return null
    }
    const standard = standardVolumeRatio(
      lineUnit,
      packUnit,
      entry,
      preparation ? null : qualifier
    )
    if (standard === null) return null
    return {
      saleUnits: yielded((amount * standard) / saleAmount),
      basis: "automatic-conversion",
    }
  }

  // The measure stated in the line's own family says what share of the
  // equivalence this line is: 1 cup of a stated 1 cup is one of them.
  let shares: number | null = null
  for (const pair of pairs) {
    const ratio = unitRatio(lineUnit, countedAsEach(pair.unit))
    if (ratio === null || pair.amount <= 0) continue
    shares = (amount * ratio) / pair.amount
    break
  }
  if (shares === null) return null

  // The same share of the measure stated in the pack's family is what the line
  // comes to in the unit it was bought in.
  for (const pair of pairs) {
    const toPack = unitRatio(countedAsEach(pair.unit), packUnit)
    if (toPack === null || pair.amount <= 0) continue
    return {
      saleUnits: yielded((shares * pair.amount * toPack) / saleAmount),
      basis: "stated-conversion",
    }
  }
  // Nothing stated reaches the unit the pack was bought in. One measure on its
  // own is not an equivalence, so the pack is its other side: a 700 g batch
  // that is 2.75 cup. So is a container with no universal size, a case or a
  // bag, whose only description is the measures stated here. Two measures
  // already relate each other, and reading the pack into them would be a
  // guess, so that line stays unpriced.
  if (
    !customPreparation &&
    (pairs.length === 1 || unitDefinition(packUnit)?.perBase === null)
  ) {
    return { saleUnits: yielded(shares), basis: "stated-conversion" }
  }
  return null
}

/**
 * The ingredient state this line asks for, or null when it asks for none.
 *
 * Exact equality on the normalized qualifier, the same rule a saved measure is
 * matched by. An unqualified line names the ingredient as bought and must not
 * pick up a preparation.
 *
 * Written against the one field it reads so weighing can call it with the same
 * preparations under a narrower type, and get its own element type back.
 */
export function matchPreparation<Preparation extends { name: string }>(
  entry: { preparations?: Preparation[] | null },
  qualifier: string | null | undefined
): Preparation | null {
  const clauses = (qualifier ?? "")
    .split(/[,;]/)
    .map(normalizeIngredientName)
    .filter(Boolean)
  if (!clauses.length) return null
  return (
    entry.preparations?.find((preparation) =>
      clauses.includes(normalizeIngredientName(preparation.name))
    ) ?? null
  )
}

export type BodyPricing = {
  lines: PricedLine[]
  totalCents: number
  unpricedCount: number
  reviewCount: number
}

export function matchPriceListEntry(
  name: string,
  priceList: PriceListEntry[],
  matches: RecipeLineMatch[] = []
): PriceListEntry | null {
  const identity = resolveRecipeIngredientIdentity(name, priceList, matches)
  return identity
    ? (priceList.find((entry) => entry.id === identity.id) ?? null)
    : null
}

export function priceIngredientLines(
  lines: PriceableLine[],
  priceList: PriceListEntry[],
  matches: RecipeLineMatch[] = []
): BodyPricing {
  let totalCents = 0
  let unpricedCount = 0
  let reviewCount = 0
  const priced = lines.map((line): PricedLine => {
    if (line.excluded) {
      return {
        ...line,
        ingredientId: null,
        costCents: null,
        basis: null,
        needsConversion: false,
        needsReview: false,
      }
    }
    const needsReview = line.needsReview ?? false
    if (needsReview) reviewCount++
    const match = matchPriceListEntry(line.name, priceList, matches)
    const unpriced = (
      ingredientId: string | null,
      needsConversion: boolean
    ): PricedLine => {
      unpricedCount++
      return {
        ...line,
        ingredientId,
        costCents: null,
        basis: null,
        needsConversion,
        needsReview,
      }
    }
    const costed = (costCents: number, basis: CostBasis): PricedLine => {
      totalCents += costCents
      return {
        ...line,
        ingredientId: match?.id ?? null,
        costCents,
        basis,
        needsConversion: false,
        needsReview,
      }
    }

    if (!match) return unpriced(null, false)

    const preparation = matchPreparation(
      match,
      line.preparationNote ?? line.qualifier
    )

    if (match.source === "component" && match.componentYieldUnit === "pcs") {
      // An `ea` line consumes whole pieces, whatever the batch weighs.
      if (
        line.componentQuantity?.unit === "each" &&
        match.componentYieldAmount !== null &&
        match.componentYieldAmount !== undefined &&
        Number.isFinite(match.componentYieldAmount) &&
        match.componentYieldAmount > 0
      ) {
        return costed(
          (line.componentQuantity.amount * match.purchaseCostCents) /
            match.componentYieldAmount,
          "sale-unit"
        )
      }
    }

    // Without a finished weight, a component's raw input sum is not a mass
    // equivalency. Its declared volume or count can still price those units.
    if (
      match.source === "component" &&
      unitDefinition(line.unit ?? null)?.family === "mass" &&
      (match.componentYieldUnit === "pcs" ||
        Boolean(match.conversion?.volume)) &&
      !match.componentWeightKnown
    ) {
      return unpriced(match.id, true)
    }

    // The unit the line was written in comes first: when it agrees with what
    // was bought, no conversion happens and none is needed.
    if (line.amount !== null && line.amount !== undefined) {
      const resolved = saleUnitsFor(
        line.amount,
        line.unit ?? null,
        match,
        preparation,
        line.qualifier ?? null
      )
      if (resolved) {
        return costed(
          resolved.saleUnits * match.purchaseCostCents,
          resolved.basis
        )
      }
    }

    // Then the weight the parser worked out, which is itself a conversion —
    // a density chart or a saved measure — so it reads as automatic.
    const customPreparation = preparation?.usesStandardConversion === false
    if (line.grams !== null && (!customPreparation || line.gramsAreExplicit)) {
      const viaGrams = saleUnitsFor(
        line.grams,
        "g",
        match,
        preparation,
        line.qualifier ?? null
      )
      if (viaGrams) {
        const basis =
          viaGrams.basis === "sale-unit" && line.unit === "g"
            ? "sale-unit"
            : viaGrams.basis === "sale-unit"
              ? "automatic-conversion"
              : viaGrams.basis
        return costed(viaGrams.saleUnits * match.purchaseCostCents, basis)
      }
    }

    return unpriced(match.id, true)
  })

  return { lines: priced, totalCents, unpricedCount, reviewCount }
}

/**
 * Price lines that are already parsed. Every consumer prices the same parse —
 * the editor's Costing tab, `priceRecipeBody`, and a component read as a price
 * source — so the mapping from a parsed line lives here once and no screen can
 * drop a field, such as the qualifier that selects a preparation.
 */
export function priceParsedLines(
  lines: ParsedRecipeLine[],
  priceList: PriceListEntry[],
  matches: RecipeLineMatch[] = []
): BodyPricing {
  return priceIngredientLines(
    // One priced line per parsed line, in order, so a caller can read the two
    // side by side. A line the recipe gave no amount, "olive oil, for
    // brushing", costs nothing and is missing nothing, so it is not an
    // unpriced line; a line the cook left out of cost reads the same way.
    lines.map((line) => ({
      name: line.ingredientName,
      amount: line.enteredAmount,
      unit: line.normalizedUnit === "assumed-g" ? "g" : line.normalizedUnit,
      grams: line.ingredient?.grams ?? null,
      gramsAreExplicit:
        line.resolutionSource === "explicit-weight" ||
        line.resolutionSource === "converted-weight" ||
        (line.resolutionSource === "entered-weight" &&
          line.normalizedUnit !== "assumed-g"),
      qualifier: line.qualifier,
      preparationNote: line.noteText,
      componentQuantity: line.componentQuantity,
      needsReview: line.measureRange?.requiresReview ?? false,
      excluded: line.alert === "unmeasured" || line.excludedFromCost === true,
    })),
    priceList,
    matches
  )
}

export function priceRecipeBody(
  body: string,
  priceList: PriceListEntry[],
  matches: RecipeLineMatch[] = [],
  measures: IngredientMeasure[] = []
): BodyPricing {
  const parsed = parseRecipeText(body, {
    matches,
    identities: priceList,
    measures,
  })
  const pricing = priceParsedLines(parsed.parsedLines, priceList, matches)
  const rejectedRanges: PricedLine[] = parsed.skippedLines
    .filter((line) => line.affectsPricing)
    .map((line) => ({
      name: line.rawLine,
      grams: null,
      ingredientId: null,
      costCents: null,
      basis: null,
      needsConversion: true,
      needsReview: false,
    }))
  return {
    ...pricing,
    lines: [...pricing.lines, ...rejectedRanges],
    unpricedCount: pricing.unpricedCount + rejectedRanges.length,
  }
}

type ComponentRecipe = {
  id: string
  title: string
  body: string
  kind?: RecipeKind | null
  yieldAmount?: number | null
  yieldUnit?: string | null
  /** What the same batch comes to in the families the yield does not state. */
  equivalency?: WeighEquivalency | null
}

/**
 * One component as a price source, or null when it cannot be priced whole.
 * A component prices like a "pack": one batch weighs its yield and costs its
 * ingredient total. Partially priced or weightless components are excluded
 * rather than contributing silent gaps.
 */
function componentPriceSource(
  recipe: ComponentRecipe,
  sources: PriceListEntry[],
  matches: RecipeLineMatch[],
  measures: IngredientMeasure[]
): PriceListEntry | null {
  const parsed = parseRecipeText(recipe.body, {
    matches,
    identities: sources,
    measures,
  })
  // Every line has to reach a cost, exactly as `RecipeHealthReadModel`
  // requires: a line the parser could not weigh is still costable when the
  // unit it was written in is the unit it was bought in, and a line that is
  // neither weighed nor costed leaves a silent gap in the component's price.
  const pricing = priceParsedLines(parsed.parsedLines, sources, matches)
  if (
    parsed.ingredients.length === 0 ||
    pricing.unpricedCount > 0 ||
    parsed.parsedLines.some(
      (line) => line.measureRange?.requiresReview ?? false
    ) ||
    parsed.skippedLines.some((line) => line.affectsPricing)
  ) {
    return null
  }
  const declaredGrams = batchAmountIn(recipe, "mass")
  const pieces = batchAmountIn(recipe, "count")
  const milliliters = batchAmountIn(recipe, "volume")
  const inputGrams = parsed.ingredients.reduce(
    (total, ingredient) => total + ingredient.grams,
    0
  )
  const grams = declaredGrams ?? inputGrams
  if (grams <= 0) return null
  const analyzed = analyzeRecipe(
    parsed.ingredients.map((ingredient) => ({
      ...ingredient,
      ...resolveNutritionIngredient(ingredient.name, sources, matches),
    }))
  )
  const delta = grams - inputGrams
  // The yield delta is assumed to be water gained (soaking) or lost
  // (evaporation). A loss larger than the batch's computed water cannot be
  // water, so that case stays unmapped rather than inventing a profile.
  const batchWaterG = analyzed.nutritionTotals.water + delta
  const nutritionPer100g =
    analyzed.unknownIngredients.length === 0 && grams > 0 && batchWaterG >= 0
      ? {
          water: (batchWaterG / grams) * 100,
          fat: (analyzed.nutritionTotals.fat / grams) * 100,
          protein: (analyzed.nutritionTotals.protein / grams) * 100,
          sugars: (analyzed.nutritionTotals.sugars / grams) * 100,
          starch: (analyzed.nutritionTotals.starch / grams) * 100,
          fiber: (analyzed.nutritionTotals.fiber / grams) * 100,
          salt: (analyzed.nutritionTotals.salt / grams) * 100,
          other: (analyzed.nutritionTotals.other / grams) * 100,
          totalCarbohydrate:
            (analyzed.nutritionTotals.totalCarbohydrate / grams) * 100,
          sodiumMg: (analyzed.nutritionTotals.sodiumMg / grams) * 100,
        }
      : null
  return {
    id: recipe.id,
    name: recipe.title,
    normalizedName: normalizeIngredientName(recipe.title),
    purchaseCostCents: Math.round(pricing.totalCents),
    purchaseSize: Math.round(grams),
    purchaseUnit: "g",
    source: "component",
    componentYieldAmount: pieces,
    // "pcs" is the one spelling a piece basis is published in, whichever word
    // the yield itself used.
    componentYieldUnit: pieces !== null ? "pcs" : null,
    componentWeightKnown: declaredGrams !== null,
    // One sale unit is one batch, so the batch's own volume is the pair that
    // turns a cup line into a share of it.
    conversion:
      milliliters !== null
        ? {
            usesStandardConversion: false,
            weight: null,
            volume: { amount: milliliters, unit: "ml" },
            each: null,
          }
        : null,
    nutritionPer100g,
  }
}

/**
 * Pantry entries plus fully-priced components as sub-recipe price sources.
 *
 * Two passes, so a component may consume another component: pass 1 prices
 * against the pantry alone, pass 2 re-prices only what failed, now against the
 * pantry plus the components pass 1 established. Fixed at two passes this
 * terminates with no recursion guard — a component that names itself, or a
 * pair that name each other, never reaches its own pass-1 entry — while still
 * covering a sub-recipe of a sub-recipe, the depth real kitchens write.
 */
export function buildPriceSources(
  pantry: PriceListEntry[],
  allRecipes: ComponentRecipe[],
  options: {
    excludeRecipeId?: string
    matches?: RecipeLineMatch[]
    measures?: IngredientMeasure[]
  } = {}
): PriceListEntry[] {
  const pantryMatches = options.matches ?? []
  const measures = options.measures ?? []
  const recipeEntries: PriceListEntry[] = []
  // Only components are ingredients. A plain recipe is a finished item, so
  // listing it here made the picker noisy and let recipes nest by accident.
  let pending = allRecipes.filter(
    (recipe) =>
      recipe.kind === "component" && recipe.id !== options.excludeRecipeId
  )
  for (let pass = 0; pass < 2 && pending.length > 0; pass++) {
    const sources = pass === 0 ? pantry : [...pantry, ...recipeEntries]
    const failed: ComponentRecipe[] = []
    for (const recipe of pending) {
      const entry = componentPriceSource(
        recipe,
        sources,
        pantryMatches,
        measures
      )
      if (entry) recipeEntries.push(entry)
      else failed.push(recipe)
    }
    pending = failed
  }
  const sources = [
    ...pantry.map((entry) => ({
      ...entry,
      source: entry.source ?? ("pantry" as const),
    })),
    ...recipeEntries,
  ]
  // Tap water is free in every kitchen: a built-in zero-cost identity, so a
  // "2 cup water" line prices at $0 instead of flagging as unrecognized. A
  // merchant's own water entry (filtered, bottled) wins over the built-in.
  if (!sources.some((entry) => entry.normalizedName === "water")) {
    sources.push({
      id: "builtin-water",
      name: "Water",
      normalizedName: "water",
      purchaseCostCents: 0,
      purchaseSize: 1000,
      purchaseUnit: "g",
      source: "pantry",
    })
  }
  return sources
}
