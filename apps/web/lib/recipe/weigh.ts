import { densityGrams } from "./density"
import { matchPreparation } from "../pricing"
import {
  convertAmount,
  countedAsEach,
  unitDefinition,
  unitRatio,
} from "../unit-registry"

/**
 * The six measures a conversion row states, on an ingredient or one of its
 * preparations: one equivalence, in weight, in volume, and in pieces. 227 g of
 * butter is 1 cup of butter, whatever pack it was bought in.
 * `usesStandardConversion` means the row states none of its own and defers to
 * the shared weight and volume table.
 */
export type IngredientConversion = {
  usesStandardConversion: boolean
  weight: { amount: number; unit: string } | null
  volume: { amount: number; unit: string } | null
  each: { amount: number; unit: string } | null
}

/**
 * The measures the row itself states, which are one equivalence between the
 * families they name. Empty when the row is on the standard conversion,
 * because that answer comes from the shared weight and volume table rather
 * than from a row here.
 */
export function conversionPairs(
  conversion: IngredientConversion | null | undefined
): { amount: number; unit: string }[] {
  if (!conversion) return []
  if (conversion.usesStandardConversion) return []
  return [conversion.weight, conversion.volume, conversion.each].filter(
    // Loose on purpose: a conversion still being typed can hold an
    // undefined side, and it must not take the whole weighing down.
    (pair): pair is { amount: number; unit: string } => Boolean(pair?.unit)
  )
}

/**
 * A state this ingredient is used in, with the measures that state comes to.
 * The same six fields an ingredient conversion states, because a cup of yolks
 * is not a cup of egg. `yieldPercent` is costing's business, not weighing's.
 */
export type WeighPreparation = IngredientConversion & { name: string }

/** The pantry fields weighing reads. A superset of this is what costing gets. */
export type WeighIngredient = {
  id: string
  name: string
  /** Canonical identity for shared measures when the pantry name is edited. */
  measureName?: string | null
  purchaseSize?: number | null
  purchaseUnit?: string | null
  conversion?: IngredientConversion | null
  preparations?: WeighPreparation[] | null
}

/**
 * What one batch of a recipe comes to in a family the yield does not state.
 * Every filled amount describes the same batch the yield does, so 2.75 cup,
 * 700 g and 8 each are three readings of one batch.
 */
export type WeighEquivalency = {
  massAmount: number | null
  massUnit: string
  volumeAmount: number | null
  volumeUnit: string
  countAmount: number | null
  countUnit: string
  /** True when the values are a density ratio, false for whole-batch values. */
  standard?: boolean
}

/** The recipe fields weighing a sub-recipe line reads. */
export type WeighRecipe = {
  id: string
  yieldAmount?: number | null
  yieldUnit?: string | null
  equivalency?: WeighEquivalency | null
}

/** The pricing entries payload, narrowed to what weighing actually reads. */
export type WeighSources = {
  items: WeighIngredient[]
  recipes: WeighRecipe[]
}

/** One editor row, as the editor holds it: quantities are still strings. */
export type WeighableLine = {
  kind: string
  quantity: string
  unit: string
  displayName: string
  /** What the line says after the ingredient: "large, room temperature". */
  preparationNote?: string | null
  ingredientId: string | null
  subrecipeId: string | null
}

/**
 * Why a line has no weight, so the editor can say which row to fix. Null on a
 * weighed line and on a row that is not a measurement at all.
 */
export type WeighReason =
  null | "unlinked" | "no-quantity" | "no-conversion" | "sub-recipe"

/** `grams` holds the line's amount in the family's base unit, whatever it is. */
export type LineWeight = { grams: number | null; reason: WeighReason }

type Family = "mass" | "volume" | "count"

/** The unit a family sums in. */
const BASE_UNIT: Record<Family, string> = {
  mass: "g",
  volume: "ml",
  count: "each",
}

/** The family a yield unit asks for; a count of pieces or slices is "count". */
export function yieldFamily(unit: string | null): Family | null {
  const family = unitDefinition(countedAsEach(unit))?.family
  return family === "mass" || family === "volume" || family === "count"
    ? family
    : null
}

/**
 * `amount unit` in the family's base unit, or null when the unit is not in
 * that family or says no quantity at all. A count of pieces or slices reaches
 * "each" first, because neither spelling converts on its own.
 */
function familyBase(
  amount: number | null | undefined,
  unit: string | null | undefined,
  family: Family
): number | null {
  if (amount === null || amount === undefined) return null
  if (!Number.isFinite(amount) || amount <= 0) return null
  const from = countedAsEach(unit ?? null)
  const base = convertAmount(amount, from, BASE_UNIT[family])
  return base !== null && base > 0 ? base : null
}

/**
 * What one batch of this recipe comes to in `family`, in grams, millilitres
 * or pieces, or null when nothing says.
 *
 * The yield answers for its own family. A custom equivalency answers the
 * others as whole-batch amounts; a standard equivalency is a density ratio
 * whose other side must first be scaled to the declared yield.
 */
export function batchAmountIn(
  recipe: WeighRecipe,
  family: Family
): number | null {
  const fromYield = familyBase(recipe.yieldAmount, recipe.yieldUnit, family)
  if (fromYield !== null) return fromYield
  const stated = recipe.equivalency
  if (!stated) return null
  const pair = (target: Family) =>
    target === "mass"
      ? { amount: stated.massAmount, unit: stated.massUnit }
      : target === "volume"
        ? { amount: stated.volumeAmount, unit: stated.volumeUnit }
        : { amount: stated.countAmount, unit: stated.countUnit }
  const target = pair(family)
  const targetBase = familyBase(target.amount, target.unit, family)
  if (stated.standard !== true) return targetBase
  const declaredFamily = yieldFamily(recipe.yieldUnit ?? null)
  if (!declaredFamily || declaredFamily === family || targetBase === null) {
    return null
  }
  const anchor = pair(declaredFamily)
  const anchorBase = familyBase(anchor.amount, anchor.unit, declaredFamily)
  const yieldBase = familyBase(
    recipe.yieldAmount,
    recipe.yieldUnit,
    declaredFamily
  )
  return anchorBase === null || yieldBase === null
    ? null
    : (yieldBase / anchorBase) * targetBase
}

/**
 * How many sale units `quantity unit` is, read off the conversion pair that
 * shares the unit's family, or off the pack size when the pack was bought by
 * weight. Null when the entry says nothing about that family.
 */
function saleUnits(
  quantity: number,
  unit: string,
  entry: WeighIngredient,
  pairs: { amount: number; unit: string }[],
  allowPackFallback = true
): number | null {
  for (const pair of pairs) {
    const ratio = unitRatio(unit, pair.unit)
    if (ratio !== null && pair.amount > 0)
      return (quantity * ratio) / pair.amount
  }
  if (!allowPackFallback) return null
  const grams = convertAmount(quantity, unit, "g")
  const packGrams = convertAmount(
    entry.purchaseSize ?? 0,
    entry.purchaseUnit ?? null,
    "g"
  )
  if (grams !== null && packGrams !== null && packGrams > 0) {
    return grams / packGrams
  }
  return null
}

/** What one sale unit comes to in `family`, in that family's base unit. */
function perSaleUnit(
  family: Family,
  entry: WeighIngredient,
  pairs: { amount: number; unit: string }[],
  allowPackFallback = true
): number | null {
  for (const pair of pairs) {
    if (unitDefinition(pair.unit)?.family !== family) continue
    const base = convertAmount(pair.amount, pair.unit, BASE_UNIT[family])
    if (base !== null && base > 0) return base
  }
  if (family !== "mass" || !allowPackFallback) return null
  // A pack bought by weight already states it: 25 kg is one sale unit.
  const grams = convertAmount(
    entry.purchaseSize ?? 0,
    entry.purchaseUnit ?? null,
    "g"
  )
  return grams !== null && grams > 0 ? grams : null
}

/**
 * What `quantity unit` of this ingredient comes to in `family`, in grams,
 * millilitres or pieces, or null when nothing says.
 *
 * A unit already in the family converts on its own, whoever sells the thing.
 * Anything else has to ask the ingredient, in the order costing does: the
 * conversion the kitchen stated first, then the shared density chart, which
 * is what the standard conversion means and only ever relates weight to
 * volume. Cost never enters into it, so an ingredient with no price still
 * measures.
 *
 * A preparation the note names goes first, because "4 each egg yolk" is asking
 * what a yolk weighs and not what an egg weighs. Its yield stays out of it: a
 * recipe line states the amount going in, already prepared.
 */
export function measureIngredientAmount(
  quantity: number,
  unit: string,
  entry: WeighIngredient,
  family: Family,
  preparationNote?: string | null
): number | null {
  const direct = convertAmount(quantity, unit, BASE_UNIT[family])
  if (direct !== null) return direct

  // A preparation's measures describe one unit of the preparation, the
  // ingredient's describe one sale unit, and the two are not the same thing,
  // so each set is read on its own: a yolk's "1 each is 17 g" must never be
  // paired with the carton's "1 cup is 243 g", or four yolks read as four cups.
  const preparation = matchPreparation(entry, preparationNote)
  const customPreparation = preparation?.usesStandardConversion === false
  const pairs = customPreparation
    ? conversionPairs(preparation)
    : conversionPairs(entry.conversion)
  const units = saleUnits(quantity, unit, entry, pairs, !customPreparation)
  const per = perSaleUnit(family, entry, pairs, !customPreparation)
  if (units !== null && per !== null) return units * per
  // A stated conversion is the kitchen's last word, even when it does not
  // relate these two families. Only rows still on the standard conversion may
  // use a known density or the shared 8 oz-weight-per-cup estimate.
  if (customPreparation || entry.conversion?.usesStandardConversion === false) {
    return null
  }
  const name = entry.measureName?.trim() || entry.name
  const from = unitDefinition(unit)?.family
  if (family === "mass" && from === "volume") {
    return densityGrams(quantity, unit, name)?.grams ?? null
  }
  if (family === "volume" && from === "mass") {
    const gramsPerCup = densityGrams(1, "cup", name)?.grams
    const grams = convertAmount(quantity, unit, "g")
    if (!gramsPerCup || grams === null) return null
    return (grams / gramsPerCup) * (convertAmount(1, "cup", "ml") ?? 0)
  }
  return null
}

/** Grams of `quantity unit` of this ingredient; the mass case of measuring. */
export function weighIngredientAmount(
  quantity: number,
  unit: string,
  entry: WeighIngredient
): number | null {
  return measureIngredientAmount(quantity, unit, entry, "mass")
}

/**
 * Measure the editor's rows in the yield's family so the sum can stand in for
 * a batch yield: grams for a weight, millilitres for a volume, pieces for a
 * count. `total` is in that family's base unit.
 *
 * Only measurements count. A header or a note carries no weight and is missing
 * none, so it neither reports a reason nor holds the total back. Every other
 * row either measures or says why it does not, and one such row makes the
 * total null: a yield summed from a batch we cannot fully measure would read
 * as a smaller batch rather than as an unknown one.
 */
export function weighRecipeLines(
  lines: WeighableLine[],
  sources: WeighSources,
  yieldUnit: string | null = "g"
): { lines: LineWeight[]; total: number | null; family: Family | null } {
  const family = yieldFamily(yieldUnit)
  if (!family) {
    return {
      lines: lines.map(() => ({ grams: null, reason: null })),
      total: null,
      family: null,
    }
  }
  let total = 0
  let complete = true
  const weighed = lines.map((line): LineWeight => {
    if (line.kind !== "ingredient" && line.kind !== "subrecipe") {
      return { grams: null, reason: null }
    }
    const missing = (reason: WeighReason): LineWeight => {
      complete = false
      return { grams: null, reason }
    }

    const quantity = Number(line.quantity.trim())
    if (!line.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0) {
      return missing("no-quantity")
    }

    if (line.kind === "subrecipe") {
      if (!line.subrecipeId) return missing("unlinked")
      // A unit already in the family measures itself, whatever the batch says.
      const direct = familyBase(quantity, line.unit, family)
      if (direct !== null) {
        total += direct
        return { grams: direct, reason: null }
      }
      // Otherwise the line is a fraction of a batch, and the batch is the only
      // thing that relates the two families: 1 cup of a 2.75 cup batch is
      // 1/2.75 of it, so it weighs 1/2.75 of what the batch weighs.
      const recipe = sources.recipes.find((one) => one.id === line.subrecipeId)
      const own = yieldFamily(line.unit)
      if (!recipe || !own) return missing("sub-recipe")
      const asked = familyBase(quantity, line.unit, own)
      const batchOwn = batchAmountIn(recipe, own)
      const batchTarget = batchAmountIn(recipe, family)
      if (asked === null || batchOwn === null || batchTarget === null) {
        return missing("sub-recipe")
      }
      const amount = (asked / batchOwn) * batchTarget
      total += amount
      return { grams: amount, reason: null }
    }

    const entry = sources.items.find((item) => item.id === line.ingredientId)
    if (!line.ingredientId || !entry) return missing("unlinked")

    const amount = measureIngredientAmount(
      quantity,
      line.unit,
      entry,
      family,
      line.preparationNote
    )
    if (amount === null) return missing("no-conversion")
    total += amount
    return { grams: amount, reason: null }
  })

  return { lines: weighed, total: complete ? total : null, family }
}
