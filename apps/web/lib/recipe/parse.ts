import vocabulary from "../../../../data/parser-vocabulary.json"

import { densityGrams } from "./density"
import { MILLILITERS_PER_UNIT } from "./volume"
import type { NutritionComposition, RecipeIngredientInput } from "./types"

export type ParsedRecipeMassUnit = string
export { MILLILITERS_PER_UNIT } from "./volume"
export type ParsedRecipeCountUnit = string
export type RecipeMeasureUnit = string
/** What a household measure can be written in: you measure with a cup or a
 * bunch, never with a gram, and a splash has no quantity to record. */
export const RECIPE_MEASURE_UNITS: string[] = vocabulary.units
  .filter(
    (unit) =>
      unit.family === "volume" || unit.family === "count" || unit.approximate
  )
  .map((unit) => unit.slug)

/** A unit whose factor is a convention rather than a fact — a pinch, a dash. */
const APPROXIMATE_UNITS = new Set(
  vocabulary.units.filter((unit) => unit.approximate).map((unit) => unit.slug)
)

export function isApproximateUnit(unit: string): boolean {
  return APPROXIMATE_UNITS.has(unit)
}
export type ParsedRecipeUnit =
  ParsedRecipeMassUnit | RecipeMeasureUnit | "assumed-g"

export type IngredientMeasure = {
  id: string
  ingredientId: string | null
  name: string
  normalizedName: string
  unit: RecipeMeasureUnit
  amount: number
  grams: number
  lowGrams: number | null
  highGrams: number | null
  qualifier: string
  source: "user" | "catalog"
  confidence: "high" | "medium" | "low"
}

export type RecipeLineMatch = {
  line: string
  targetId: string
  targetName?: string
  measureName?: string | null
  targetKind?: "ingredient" | "recipe"
}

export type RecipeIngredientIdentity = {
  id: string
  name: string
  normalizedName: string
  measureName?: string | null
  source?: "pantry" | "component" | "master" | "catalog"
  /** Cost basis for a component recipe that yields discrete pieces. */
  componentYieldAmount?: number | null
  componentYieldUnit?: "pcs" | null
  /** False means the kitchen's own measures have the last word. */
  conversion?: { usesStandardConversion: boolean } | null
  nutritionPer100g?: NutritionComposition | null
}

export type ParseRecipeOptions = {
  measures?: IngredientMeasure[]
  matches?: RecipeLineMatch[]
  identities?: RecipeIngredientIdentity[]
}

export type RecipeLineResolutionSource =
  | "entered-weight"
  | "converted-weight"
  | "explicit-weight"
  | "profile"
  | "user-measure"
  | "catalog-measure"
  | "component-yield"
  | "density"
  | "approximate-unit"

export type ParsedRecipeLine = {
  kind: "ingredient"
  lineNumber: number
  rawLine: string
  /** Zero for an unmeasured line: "olive oil, for brushing" states no amount. */
  enteredAmount: number
  enteredUnit: string | null
  /** The unit the line was read in; null when it carried no unit token and
   * nothing matched, so the line states an amount of something unknown. */
  normalizedUnit: ParsedRecipeUnit | null
  /** The name as written, annotations included, which pricing matches on. */
  ingredientName: string
  /** What the row is called: the written name without its annotations. */
  baseName: string
  /** The size the piece was written in, so a saved "large" measure matches. */
  sizeWord: string | null
  /** Names a match may be tried under, most specific first. */
  identityCandidates: string[]
  qualifier: string | null
  /** The annotations the name carried, verbatim and joined with ", ". */
  noteText: string | null
  note: string | null
  ingredient: RecipeIngredientInput | null
  /** A count-costed component can be priced without inventing a gram weight. */
  componentQuantity: { amount: number; unit: "each" } | null
  /** Name reached a known ingredient. `ingredient` also requires a gram weight. */
  identityMatched: boolean
  resolutionSource: RecipeLineResolutionSource | null
  measureRange: {
    lowGrams: number
    highGrams: number
    requiresReview: boolean
  } | null
  /** A written range ("3 1/2 to 4 cups"): the line is read at its low end. */
  amountRange: { low: number; high: number } | null
  /** The second measure a line stated for the same quantity ("1 cup (250 g)"). */
  equivalent: { amount: number; unit: ParsedRecipeUnit } | null
  /** "unmeasured": a real ingredient the recipe never gave an amount for. */
  alert: "unmeasured" | null
  /** The cook left this line out of cost. Money only. */
  excludedFromCost?: boolean
}

/** A section heading or a standalone note: text the paste keeps in place. */
export type ParsedRecipeSectionLine = {
  kind: "header" | "note"
  lineNumber: number
  rawLine: string
  text: string
}

export type SkippedRecipeLine = {
  lineNumber: number
  rawLine: string
  reason: string
  affectsPricing: boolean
  // "prose" is a line that never looked like an ingredient (method, a note);
  // "unconvertible" had a real amount but could not be turned into grams, so
  // a reader who only sees prose would silently lose an ingredient.
  kind: "prose" | "unconvertible"
}

export type ParseRecipeTextResult = {
  ingredients: RecipeIngredientInput[]
  parsedLines: ParsedRecipeLine[]
  unresolvedLines: ParsedRecipeLine[]
  /** Section headings, in written order. */
  headerLines: ParsedRecipeSectionLine[]
  /** Standalone notes ("Note: chill 1 hr"), in written order. */
  noteLines: ParsedRecipeSectionLine[]
  skippedLines: SkippedRecipeLine[]
}

// The word lists this parser and `domains/recipes/health.py` must spell the
// same way live in `data/parser-vocabulary.json`; each engine assembles its own
// regexes from them.
/** Grams in one of every mass unit, not only the four a screen displays. */
const GRAMS_PER_MASS_UNIT: Record<string, number> = Object.fromEntries(
  vocabulary.units
    .filter((unit) => unit.family === "mass" && unit.perBase !== null)
    .map((unit) => [unit.slug, unit.perBase as number])
)

const COUNT_UNITS = new Set<ParsedRecipeUnit>(
  vocabulary.units
    .filter((unit) => unit.family === "count")
    .map((unit) => unit.slug)
)

const VULGAR_FRACTIONS: Record<string, string> = vocabulary.vulgarFractions

/**
 * What a pasted list puts in front of an ingredient.
 *
 * A bullet or a checkbox glyph carries no meaning of its own, so it is removed
 * before the line is read. Recipe sites that render tickable ingredient lists
 * paste a checkbox — losing those drops every line of the recipe. `-` and `*`
 * are handled separately below because they are ordinary punctuation: they must
 * be followed by a space to count as a marker, or "-1" reads as a marker plus a
 * quantity.
 */
const listMarkerGlyphs = vocabulary.listMarkerGlyphs
  .join("")
  .replace(/[\\\]^-]/g, "\\$&")
const listMarkerPattern = new RegExp(`^(?:[-*]\\s+|[${listMarkerGlyphs}]\\s*)`)

const amountSource =
  "(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+)"
const amountPattern = new RegExp(`^(${amountSource})\\s*(.*)$`)
const rangePattern = new RegExp(
  `^(${amountSource})\\s*(?:-|–|—|to)\\s*(${amountSource})\\b(.*)$`,
  "i"
)
// A heading: a markdown hash, or a short label closed by a colon with nothing
// after it. "Note: chill 1 hr" keeps its text, so it is not a heading.
const headingMarkerPattern = /^#{1,6}\s+(.+)$/
const headingLabelPattern = /^([^:]{1,80}):$/
const standaloneNotePattern = /^(?:notes?|tips?)\s*:\s*(.+)$/i
// A range tail that names time or temperature is a method line, not an
// ingredient, so it must not be reported as affecting a price. The bare
// temperature letter is case-sensitive: "1-2 c flour" is a cup of flour.
const nonIngredientRangeTailPattern =
  /^(?:minutes?|mins?|hours?|hrs?|seconds?|secs?|degrees?|deg)\b/i
const temperatureRangeTailPattern = /^(?:°\s?[CFcf]|[CF])\b/
// A second amount joined to the first ("2 tbsp plus 1 tsp"), which the single
// amount the line reports cannot represent.
const residualAmountPattern = new RegExp(
  `^(?:plus|\\+|and)\\s*(?:${amountSource})\\b`,
  "i"
)
// A decimal comma. A thousands group keeps three digits after the comma, so
// "1,500" stays an amount while "1,5" is a locale we refuse to guess at.
const decimalCommaPattern = /\d+,\d{1,2}(?!\d)/
// A list marker: an integer closed by a period or paren with no digit after
// it, so "1. Mix the dough" is a step while "1.5 kg Flour" stays an amount.
const numberedInstructionPattern = /^\d+\s*[.)](?!\d)\s*\S/

// Order is load-bearing: the alternation below matches left to right, so a
// longer spelling has to precede one that is its prefix ("fl oz" before "oz").
const unitAliases: ReadonlyArray<{
  unit: Exclude<ParsedRecipeUnit, "assumed-g">
  pattern: string
}> = vocabulary.units
  .filter((unit) => typeof unit.pattern === "string")
  .map((unit) => ({
    unit: unit.slug as Exclude<ParsedRecipeUnit, "assumed-g">,
    pattern: unit.pattern as string,
  }))

const unitPatterns = new Map(
  unitAliases.map(({ unit, pattern }) => [unit, pattern])
)
const unitSource = unitAliases.map(({ pattern }) => pattern).join("|")
const massUnitSource = vocabulary.units
  .filter((unit) => unit.family === "mass")
  .map((unit) => unitPatterns.get(unit.slug))
  .filter(Boolean)
  .join("|")
const countUnitSource = unitAliases
  .filter(({ unit }) => COUNT_UNITS.has(unit))
  .map(({ pattern }) => pattern)
  .join("|")

const supportedUnitPattern = new RegExp(
  `^(${unitSource})\\.?(?:\\s*,\\s*|\\s+|$)(.*)$`,
  "i"
)
const nameUnitAmountPattern = new RegExp(
  `^(.+?)\\s+(${unitSource})\\.?\\s+(${amountSource})$`,
  "i"
)
const nameAmountUnitPattern = new RegExp(
  `^(.+?)\\s+(${amountSource})(?:\\s*(${unitSource})\\.?)?$`,
  "i"
)
const explicitWeightPattern = new RegExp(
  `^\\(\\s*(${amountSource})\\s*(?:-\\s*)?(${massUnitSource})\\.?(?:\\s+(total|each))?\\s*\\)\\s*(.*)$`,
  "i"
)
const unparenthesizedContainerWeightPattern = new RegExp(
  `^(${amountSource})\\s*(?:-\\s*)?(${massUnitSource})\\.?\\s+(${countUnitSource})\\.?\\s+(.+)$`,
  "i"
)
const methodTailPattern =
  /(?:^|\s)(at|to|for|of|about|until|minutes?|hours?|degrees?)$/i

// A clause a cook hangs off a semicolon is always an aside about the
// ingredient, never more of its name: "kosher salt; for table salt, use half
// as much by volume". It is taken whole, commas and all.
const semicolonClausePattern = /^([^;]+);\s*(\S.*)$/
// Where the ingredient came from, written straight onto the line: "lemon juice
// from 6 medium lemons".
const sourceClausePattern = /^(.+?),?\s+(from\s+\S.*)$/i
// A clause opening on a past participle says what was done to the ingredient,
// so it reads as a note even when the word is not one this parser knows:
// "Tart Crust, baked and cooled".
const participleClausePattern = /^[a-z]+ed\b/i

const qualifierWords = vocabulary.qualifierWords
// A comma clause is a preparation note in full, and recipes write them as prose:
// "garlic, pressed or minced", "mushrooms, cleaned + sliced". Anchoring on the
// qualifier word alone left the rest of the clause welded to the base name, so
// the ingredient identity never matched what the same line matches without it.
const qualifierClausePattern = new RegExp(
  `\\b(?:${qualifierWords.join("|")})\\b`,
  "i"
)
const nonMeasureAnnotationPattern = new RegExp(
  `^(?:or\\s+)?(?:${vocabulary.nonMeasureAnnotations.join("|")})$`,
  "i"
)
// "salt, to taste" and "salt to taste" are one line: the comma is how some
// cooks write it, not what makes the phrase an annotation.
const trailingAnnotationPattern = new RegExp(
  `^(.+?)(?:,\\s*|\\s+)((?:or\\s+)?(?:${vocabulary.nonMeasureAnnotations.join("|")}))$`,
  "i"
)
// A size word describes the piece, never the ingredient's identity or its
// weight per unit volume, so it is kept off the identity rather than held as a
// qualifier: a qualifier would stop a saved measure for the plain ingredient
// matching.
// A parenthetical that only restates the measure ("(30ml)") describes the
// amount, not a preparation, so it must not become a qualifier and block a
// density or a saved measure.
const measureAnnotationPattern = new RegExp(
  `^(?:${amountSource})\\s*(?:${unitSource})\\.?$`,
  "i"
)
const measureAnnotationCapturePattern = new RegExp(
  `^(${amountSource})\\s*(${unitSource})\\.?$`,
  "i"
)
// A line that states its measure only in front, in brackets: "(30ml) olive
// oil", "(1lb/454g) mozzarella". The first measure is what the line asks for
// and the second, when written, restates it in another system.
const leadingMeasurePattern = new RegExp(
  `^\\(\\s*(${amountSource})\\s*(${unitSource})\\.?` +
    `(?:\\s*[/|]\\s*(${amountSource})\\s*(${unitSource})\\.?)?\\s*\\)\\s*(.+)$`,
  "i"
)
// A gesture in place of an amount: "Drizzle of avocado oil".
const vagueQuantityPattern =
  /^(?:an?\s+)?(pinch|dash|drizzle|splash|handful|sprinkle|squeeze|knob|glug)\s+of\s+(.+)$/i
// The size word itself, so "1 large egg" can be read as one large.
const sizeUnitPattern = new RegExp(
  `^(${vocabulary.sizeWords.join("|")})\\s+(.+)$`,
  "i"
)
/** Size words that stand in for a count unit: one large is one piece. */
const SIZE_UNITS = new Set(
  vocabulary.units
    .filter((unit) => unit.group === "size")
    .map((unit) => unit.slug)
)

/**
 * Characters that pasted recipe text carries but the patterns cannot read:
 * zero-width joiners and marks, the non-breaking space family (a paste of
 * "1 1/2 cups" usually joins the whole number and the fraction with one), and
 * the fraction slash.
 */
function normalizeLineCharacters(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u00A0\u2007\u2009\u202F]/g, " ")
    .replace(/\u2044/g, "/")
}

function normalizeVulgarFractions(value: string): string {
  let result = ""
  for (const character of value) {
    const replacement = VULGAR_FRACTIONS[character]
    if (!replacement) {
      result += character
      continue
    }
    if (result && /\d$/.test(result)) result += " "
    result += replacement
  }
  return result
}

// Kept identical to lib/pricing.ts:normalizeIngredientName — a written line is
// compared against pantry keys that helper produced, so an accent folded on one
// side and kept on the other is a silent miss. Not imported from there because
// pricing.ts imports this module.
function normalizeIngredientName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * A quantity a recipe can be written in and a database column can hold: six
 * decimals, which is what `1 1/3` means in a kitchen and what the quantity
 * columns store. Float dust past that place is not precision, it is a value
 * the backend refuses.
 */
export function roundRecipeQuantity(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

export function parseRecipeAmount(value: string): number | null {
  const normalized = normalizeVulgarFractions(value).replaceAll(",", "").trim()

  if (normalized.includes(" ")) {
    const [whole, fraction] = normalized.split(/\s+/, 2)
    const parsedWhole = Number(whole)
    const parsedFraction = fraction ? parseRecipeAmount(fraction) : null
    if (!Number.isFinite(parsedWhole) || parsedFraction === null) return null
    return roundRecipeQuantity(parsedWhole + parsedFraction)
  }

  if (normalized.includes("/")) {
    const [numerator, denominator] = normalized.split("/", 2).map(Number)
    if (
      !Number.isFinite(numerator) ||
      !Number.isFinite(denominator) ||
      denominator === 0
    ) {
      return null
    }
    return roundRecipeQuantity(numerator / denominator)
  }

  const amount = Number(normalized)
  return Number.isFinite(amount) ? roundRecipeQuantity(amount) : null
}

function normalizeUnit(unit: string): ParsedRecipeUnit {
  const normalized = unit
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
  const alias = unitAliases.find(({ pattern }) =>
    new RegExp(`^(?:${pattern})$`, "i").test(normalized)
  )
  if (alias) return alias.unit
  return "each"
}

function isMassUnit(unit: ParsedRecipeUnit): unit is ParsedRecipeMassUnit {
  return unit in GRAMS_PER_MASS_UNIT
}

function isVolumeUnit(unit: ParsedRecipeUnit): boolean {
  return unit in MILLILITERS_PER_UNIT
}

export function isCountUnit(
  unit: ParsedRecipeUnit
): unit is ParsedRecipeCountUnit {
  return COUNT_UNITS.has(unit)
}

function massToGrams(amount: number, unit: ParsedRecipeMassUnit): number {
  return amount * GRAMS_PER_MASS_UNIT[unit]
}

function formatAmount(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

function formatConvertedGrams(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/** An annotation and where the cook wrote it, so notes keep written order. */
type WrittenAnnotation = { at: number; text: string }

/**
 * Whether a parenthetical only restates the measure. A recipe often restates
 * it twice, "(5 1/4 ounces; 150 g)", and neither half says anything about
 * how the ingredient was prepared, so none of it may become a qualifier.
 */
function isMeasureRestatement(annotation: string): boolean {
  return annotation
    .split(";")
    .every((part) => measureAnnotationPattern.test(part.trim()))
}

/** The ingredient identity as written, with only spelling folded. */
function identityCandidateNames(identityName: string): string[] {
  const identity = normalizeIngredientName(identityName)
  return identity ? [identity] : []
}

function ingredientDescription(name: string): {
  /** What the row is called, size words kept: "large egg". */
  baseName: string
  /** The same name without its size word, which is what a pantry stocks. */
  identityName: string
  /** The size the piece was written in: "large" of "3 large eggs". */
  sizeWord: string | null
  /** Names a match may be tried under, most specific first. */
  identityCandidates: string[]
  normalized: string
  baseNormalized: string
  qualifier: string | null
  /** The peeled annotations as the recipe wrote them, in written order. */
  noteText: string | null
  /** A parenthetical that only restated the measure: "(240 ml)". */
  equivalentText: string | null
} {
  const normalized = normalizeIngredientName(name)
  const written = name.trim()
  const qualifiers: WrittenAnnotation[] = []
  const notes: WrittenAnnotation[] = []
  let equivalentText: string | null = null
  // Where the cook wrote it, so a note peeled off the end and one taken from
  // the middle of the line still read back in the order they were written.
  const locate = (raw: string): number => {
    const at = written.indexOf(raw)
    return at < 0 ? written.length : at
  }
  const addNote = (raw: string) => notes.push({ at: locate(raw), text: raw })
  const addQualifier = (raw: string) =>
    qualifiers.push({ at: locate(raw), text: normalizeIngredientName(raw) })

  // A parenthetical is an aside wherever the cook put it: "(240 ml) lemon
  // juice", "lemon zest (1 ounce; 28 g) from 6 lemons". Taking them all out
  // first leaves the loop below a name carrying only its trailing clauses.
  let baseName = written
    .replace(/\(([^()]*)\)/g, (_whole, inner: string, offset: number) => {
      const annotation = inner.trim()
      if (!annotation) return " "
      notes.push({ at: offset, text: annotation })
      if (isMeasureRestatement(annotation)) {
        // Only a single measure can be read back as the line's other measure;
        // "(5 1/4 ounces; 150 g)" states two and stays a note.
        if (measureAnnotationPattern.test(annotation))
          equivalentText = annotation
      } else if (!nonMeasureAnnotationPattern.test(annotation)) {
        qualifiers.push({
          at: offset,
          text: normalizeIngredientName(annotation),
        })
      }
      return " "
    })
    .replace(/\s+/g, " ")
    .trim()

  // Peel terminal annotations one at a time. Real recipe text commonly
  // composes them, e.g. "Flour, divided" or "Flour, sifted, room temperature".
  while (baseName) {
    // Peeling an annotation off the end leaves the comma that introduced it.
    baseName = baseName.replace(/[,;]+$/, "").trim()
    const semicolonClause = baseName.match(semicolonClausePattern)
    if (semicolonClause?.[1] && semicolonClause[2]) {
      addNote(semicolonClause[2].trim())
      baseName = semicolonClause[1].trim()
      continue
    }
    const trailingAnnotation = baseName.match(/^(.*?),\s*([^,]+)$/)
    const clause = trailingAnnotation?.[2]?.trim() ?? ""
    if (trailingAnnotation?.[1] && clause) {
      if (nonMeasureAnnotationPattern.test(clause)) {
        addNote(clause)
        baseName = trailingAnnotation[1].trim()
        continue
      }
      if (qualifierClausePattern.test(clause)) {
        addQualifier(clause)
        addNote(clause)
        baseName = trailingAnnotation[1].trim()
        continue
      }
      if (participleClausePattern.test(clause)) {
        addNote(clause)
        baseName = trailingAnnotation[1].trim()
        continue
      }
    }
    const sourceClause = baseName.match(sourceClausePattern)
    if (sourceClause?.[1] && sourceClause[2]) {
      addNote(sourceClause[2].trim())
      baseName = sourceClause[1].trim()
      continue
    }
    break
  }
  // The size word stays on the label, a large egg being what the cook reaches
  // for, but never on the identity a saved measure is looked up by.
  const size = baseName.match(sizeUnitPattern)
  const sizeWord = size?.[1] ?? null
  if (size?.[2]) baseName = size[2].trim()
  const inOrder = (annotations: WrittenAnnotation[]) =>
    [...annotations]
      .sort((left, right) => left.at - right.at)
      .map((a) => a.text)
  const qualifierText = inOrder(qualifiers)
  const noteParts = inOrder(notes)
  return {
    baseName: sizeWord ? `${sizeWord} ${baseName}` : baseName,
    identityName: baseName,
    sizeWord: sizeWord ? sizeWord.toLowerCase() : null,
    identityCandidates: identityCandidateNames(baseName),
    normalized,
    baseNormalized: normalizeIngredientName(baseName),
    qualifier: qualifierText.length ? qualifierText.join(" ") : null,
    noteText: noteParts.length ? noteParts.join(", ") : null,
    equivalentText,
  }
}

/** Ingredient identity without a preparation qualifier, preserving display case. */
export function recipeIngredientBaseName(name: string): string {
  return ingredientDescription(name).identityName
}

type MeasureProfile = {
  name: string
  aliases: string[]
  eachWeightG?: number
}

/**
 * Every profile name and alias, normalized, so a line naming "strong flour"
 * reaches the "bread flour" measures and each-weights. The Python read model
 * builds the same map from the same manifest, which is what keeps the recipe
 * list from weighing a line differently than the editor does.
 */
const profilesByAlias = new Map<string, MeasureProfile>(
  (vocabulary.ingredientProfiles as MeasureProfile[]).flatMap((profile) =>
    [profile.name, ...profile.aliases].map(
      (term) => [normalizeIngredientName(term), profile] as const
    )
  )
)

function measureProfile(baseNormalized: string): MeasureProfile | null {
  return profilesByAlias.get(baseNormalized) ?? null
}

// Callers pass the same arrays for every line of a recipe, so the lookup
// indexes are memoized on array identity. Shared empty defaults keep
// argument-less calls on the cache too.
const EMPTY_MEASURES: IngredientMeasure[] = []
const EMPTY_MATCHES: RecipeLineMatch[] = []
const EMPTY_IDENTITIES: RecipeIngredientIdentity[] = []

const identityIndexes = new WeakMap<
  RecipeIngredientIdentity[],
  {
    byName: Map<string, RecipeIngredientIdentity>
    byId: Map<string, RecipeIngredientIdentity>
  }
>()

function identityIndex(identities: RecipeIngredientIdentity[]) {
  const cached = identityIndexes.get(identities)
  if (cached) return cached
  const index = {
    byName: new Map(identities.map((entry) => [entry.normalizedName, entry])),
    byId: new Map(identities.map((entry) => [entry.id, entry])),
  }
  identityIndexes.set(identities, index)
  return index
}

const matchIndexes = new WeakMap<
  RecipeLineMatch[],
  Map<string, RecipeLineMatch>
>()

function matchIndex(matches: RecipeLineMatch[]) {
  const cached = matchIndexes.get(matches)
  if (cached) return cached
  const index = new Map(
    matches.map((entry) => [normalizeIngredientName(entry.line), entry])
  )
  matchIndexes.set(matches, index)
  return index
}

const measureIndexes = new WeakMap<
  IngredientMeasure[],
  {
    byNormalizedName: Map<string, number[]>
    byIngredientId: Map<string, number[]>
  }
>()

function measureIndex(measures: IngredientMeasure[]) {
  const cached = measureIndexes.get(measures)
  if (cached) return cached
  const byNormalizedName = new Map<string, number[]>()
  const byIngredientId = new Map<string, number[]>()
  measures.forEach((measure, position) => {
    const named = byNormalizedName.get(measure.normalizedName)
    if (named) named.push(position)
    else byNormalizedName.set(measure.normalizedName, [position])
    if (measure.ingredientId !== null) {
      const owned = byIngredientId.get(measure.ingredientId)
      if (owned) owned.push(position)
      else byIngredientId.set(measure.ingredientId, [position])
    }
  })
  const index = { byNormalizedName, byIngredientId }
  measureIndexes.set(measures, index)
  return index
}

/**
 * Select the one ingredient identity used by both weight resolution and
 * pricing. A real exact pantry/component match beats an older line match; a line match
 * beats an exact starter or Catalog suggestion.
 */
export function resolveRecipeIngredientIdentity(
  name: string,
  identities: RecipeIngredientIdentity[],
  matches: RecipeLineMatch[] = EMPTY_MATCHES
): RecipeIngredientIdentity | null {
  const description = ingredientDescription(name)
  const { byName: identitiesByName, byId: identitiesById } =
    identityIndex(identities)
  const matchesByName = matchIndex(matches)
  const exact =
    identitiesByName.get(description.normalized) ??
    identitiesByName.get(description.baseNormalized)
  const match =
    matchesByName.get(description.normalized) ??
    matchesByName.get(description.baseNormalized)
  const matchIdentity = identitiesById.get(match?.targetId ?? "")
  return (
    (exact?.source === "master" || exact?.source === "catalog"
      ? (matchIdentity ?? exact)
      : (exact ?? matchIdentity)) ?? null
  )
}

/** The resolved nutrition identity of an ingredient line. */
export type NutritionIngredientIdentity = {
  /** The ingredient name the nutrition analysis should key off. */
  name: string
  /**
   * True when the line resolved to a component (another recipe). Components
   * are never matched to a built-in ingredient profile, so a component titled
   * `Honey` is not attributed raw honey's macros.
   */
  isComponent: boolean
  nutritionPer100g: NutritionComposition | null
}

/**
 * The ingredient identity the nutrition analysis should key off, so it agrees
 * with the pricing path on which ingredient a line is. Both consumers resolve
 * through {@link resolveRecipeIngredientIdentity}, so when a line match or catalog
 * identity redirects a line — e.g. `Butter` repriced as `Olive Oil` — nutrition
 * reads the same ingredient's profile instead of the raw recipe text. Falls
 * back to the written name when nothing redirects it.
 *
 * A pantry entry linked to the catalog keeps its canonical `measureName` when
 * the cook renames it, and {@link resolveMeasure} already converts through that
 * name — so nutrition reads it too, or a renamed `Flour` sold as
 * `House Flour` would silently lose its macros. Components are recipes, not
 * catalog ingredients, so they stay on their own title and carry `isComponent`
 * so the analysis keeps them distinct from a same-named raw ingredient.
 */
export function resolveNutritionIngredient(
  name: string,
  identities: RecipeIngredientIdentity[] = EMPTY_IDENTITIES,
  matches: RecipeLineMatch[] = EMPTY_MATCHES
): NutritionIngredientIdentity {
  const identity = resolveRecipeIngredientIdentity(name, identities, matches)
  if (!identity) return { name, isComponent: false, nutritionPer100g: null }
  const isComponent = identity.source === "component"
  const measureName = isComponent ? null : identity.measureName?.trim()
  return {
    name: measureName ? measureName : identity.name,
    isComponent,
    nutritionPer100g: identity.nutritionPer100g ?? null,
  }
}

function resolveMeasure(
  amount: number,
  unit: RecipeMeasureUnit,
  ingredientName: string,
  options: ParseRecipeOptions
): {
  grams: number
  note: string
  source: "user-measure" | "catalog-measure"
  range: ParsedRecipeLine["measureRange"]
} | null {
  const description = ingredientDescription(ingredientName)
  const profile = measureProfile(description.baseNormalized)
  const profileNormalized = profile
    ? normalizeIngredientName(profile.name)
    : null
  const matchesByName = matchIndex(options.matches ?? EMPTY_MATCHES)
  const match =
    matchesByName.get(description.normalized) ??
    matchesByName.get(description.baseNormalized)
  const selectedIdentity = resolveRecipeIngredientIdentity(
    ingredientName,
    options.identities ?? EMPTY_IDENTITIES,
    options.matches
  )
  const matchTarget = match?.targetId
  const matchTargetMeasureName = match?.measureName ?? match?.targetName
  const matchTargetNormalized = matchTargetMeasureName
    ? normalizeIngredientName(matchTargetMeasureName)
    : null
  const selectedMeasureNames = new Set(
    [
      selectedIdentity?.normalizedName,
      selectedIdentity?.name,
      selectedIdentity?.measureName,
    ]
      .filter((value): value is string => Boolean(value))
      .map(normalizeIngredientName)
  )
  const measureMatchesIdentity = (measure: IngredientMeasure) =>
    measure.ingredientId === selectedIdentity?.id ||
    (measure.ingredientId === null &&
      selectedIdentity?.source !== "component" &&
      selectedMeasureNames.has(measure.normalizedName))
  const measureMatchesMatch = (measure: IngredientMeasure) =>
    measure.ingredientId === matchTarget ||
    (measure.ingredientId === null &&
      match?.targetKind !== "recipe" &&
      matchTargetNormalized !== null &&
      measure.normalizedName === matchTargetNormalized)

  const measures = options.measures ?? EMPTY_MEASURES
  const index = measureIndex(measures)
  const candidatePositions = new Set<number>()
  const collectByName = (normalizedName: string | null) => {
    if (normalizedName === null) return
    for (const position of index.byNormalizedName.get(normalizedName) ?? []) {
      candidatePositions.add(position)
    }
  }
  const collectByIngredientId = (ingredientId: string | undefined) => {
    if (ingredientId === undefined) return
    for (const position of index.byIngredientId.get(ingredientId) ?? []) {
      candidatePositions.add(position)
    }
  }
  if (selectedIdentity !== null) {
    collectByIngredientId(selectedIdentity.id)
    for (const measureName of selectedMeasureNames) collectByName(measureName)
  } else if (match !== undefined) {
    collectByIngredientId(matchTarget)
    collectByName(matchTargetNormalized)
  } else {
    collectByName(description.normalized)
    collectByName(description.baseNormalized)
    collectByName(profileNormalized)
  }

  // Equal scores are settled by the measures array order, so candidates are
  // restored to that order before the stable sort below.
  const candidates = [...candidatePositions]
    .sort((left, right) => left - right)
    .map((position) => measures[position])
    .filter((measure) => {
      if (
        !Number.isFinite(measure.amount) ||
        measure.amount <= 0 ||
        !Number.isFinite(measure.grams) ||
        measure.grams <= 0
      ) {
        return false
      }
      const identityMatches =
        selectedIdentity !== null
          ? measureMatchesIdentity(measure)
          : match !== undefined
            ? measureMatchesMatch(measure)
            : measure.normalizedName === description.normalized ||
              measure.normalizedName === description.baseNormalized ||
              measure.normalizedName === profileNormalized
      if (!identityMatches) return false
      const measureQualifier = normalizeIngredientName(measure.qualifier)
      if (measureQualifier !== (description.qualifier ?? "")) {
        return false
      }
      return (
        measure.unit === unit ||
        (isVolumeUnit(measure.unit) && isVolumeUnit(unit))
      )
    })
    .map((measure) => {
      const direct = measure.unit === unit
      const exactName = measure.normalizedName === description.normalized
      const profileMatch = measure.normalizedName === profileNormalized
      // Identity and qualifier are settled by the filter above — every
      // surviving candidate matches both — so only these four terms can
      // change a ranking.
      const score =
        (measure.source === "user" ? 100 : 0) +
        (exactName ? 20 : 0) +
        (profileMatch ? 12 : 0) +
        (direct ? 10 : 0) +
        (measure.confidence === "high"
          ? 3
          : measure.confidence === "medium"
            ? 2
            : 1)
      const grams = direct
        ? (amount / measure.amount) * measure.grams
        : ((amount * MILLILITERS_PER_UNIT[unit]) /
            (measure.amount * MILLILITERS_PER_UNIT[measure.unit])) *
          measure.grams
      return { measure, grams, score, direct }
    })
    .sort((left, right) => right.score - left.score)

  const selected = candidates[0]
  if (!selected) return null
  const source =
    selected.measure.source === "user" ? "user-measure" : "catalog-measure"
  const label =
    selected.measure.source === "user" ? "saved measure" : "catalog estimate"
  const low = selected.measure.lowGrams
  const high = selected.measure.highGrams
  const rangeScale = selected.grams / selected.measure.grams
  const range =
    low !== null &&
    high !== null &&
    Number.isFinite(low) &&
    Number.isFinite(high) &&
    low > 0 &&
    high >= low
      ? {
          lowGrams: low * rangeScale,
          highGrams: high * rangeScale,
          requiresReview:
            selected.measure.source === "catalog" &&
            (high - low) / ((high + low) / 2) > 0.1,
        }
      : null
  const rangeNote = range
    ? ` Source range: ${formatConvertedGrams(range.lowGrams)}–${formatConvertedGrams(range.highGrams)} g${range.requiresReview ? "; review this estimate" : ""}.`
    : ""
  return {
    grams: selected.grams,
    note: `Converted using a ${label}${selected.direct ? "" : " derived from another volume"}.${rangeNote}`,
    source,
    range,
  }
}

type LineExtraction = {
  enteredAmount: number
  rawUnit: string | null
  ingredientName: string
}

function tryNameFirst(rawLine: string): LineExtraction | null {
  const unitBetween = rawLine.match(nameUnitAmountPattern)
  if (unitBetween) {
    const [, name, token, amountRaw] = unitBetween
    const amount = parseRecipeAmount(amountRaw)
    if (amount !== null && amount > 0) {
      return {
        enteredAmount: amount,
        rawUnit: token,
        ingredientName: name.trim(),
      }
    }
  }

  const amountLast = rawLine.match(nameAmountUnitPattern)
  if (!amountLast) return null
  const [, name, amountRaw, token] = amountLast
  const amount = parseRecipeAmount(amountRaw)
  if (amount === null || amount <= 0) return null
  const ingredientName = name.trim()
  if (!ingredientName || methodTailPattern.test(ingredientName)) return null
  return { enteredAmount: amount, rawUnit: token ?? null, ingredientName }
}

function joinNotes(...parts: (string | null | undefined)[]): string | null {
  const kept = parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
  return kept.length ? kept.join(", ") : null
}

/** Whether the words alone reach an ingredient this kitchen knows. */
function knownIngredient(name: string, options: ParseRecipeOptions): boolean {
  const description = ingredientDescription(name)
  return (
    measureProfile(description.baseNormalized) !== null ||
    resolveRecipeIngredientIdentity(
      name,
      options.identities ?? EMPTY_IDENTITIES,
      options.matches
    ) !== null
  )
}

/**
 * An ingredient line that never states an amount. It is an ingredient when a
 * gesture stands in for the measure ("Drizzle of avocado oil"), when the line
 * ends in an annotation that only an ingredient carries ("…, to taste"), or
 * when it opens with a name the kitchen already knows — the rest of the line
 * being the note that name was written with.
 */
function unmeasuredExtraction(
  line: string,
  options: ParseRecipeOptions
): { name: string; unit: ParsedRecipeUnit | null; rest: string } | null {
  const vague = line.match(vagueQuantityPattern)
  if (vague?.[1] && vague[2]) {
    const alias = unitAliases.find(({ pattern }) =>
      new RegExp(`^(?:${pattern})$`, "i").test(vague[1].toLowerCase())
    )
    return { name: vague[2].trim(), unit: alias?.unit ?? null, rest: "" }
  }
  const trailingAnnotation = line.match(trailingAnnotationPattern)
  if (trailingAnnotation?.[1] && trailingAnnotation[2]) {
    return {
      name: `${trailingAnnotation[1].trim()}, ${trailingAnnotation[2].trim()}`,
      unit: null,
      rest: "",
    }
  }
  const prefix = knownIngredientPrefix(line, options)
  return prefix ? { name: prefix.name, unit: null, rest: prefix.rest } : null
}

/**
 * The longest opening the kitchen recognizes, and the rest of the line. What
 * follows an ingredient it knows is what the cook wrote about it: "kosher
 * salt, halve for table salt" is salt with an instruction, not a new name.
 */
function knownIngredientPrefix(
  line: string,
  options: ParseRecipeOptions
): { name: string; rest: string } | null {
  const segments = line.split(",")
  for (let count = segments.length; count >= 1; count -= 1) {
    const candidate = segments.slice(0, count).join(",").trim()
    if (!candidate) continue
    if (knownIngredient(candidate, options)) {
      return {
        name: candidate,
        rest: segments
          .slice(count)
          .join(",")
          .replace(/^\s*,?\s*/, "")
          .trim(),
      }
    }
  }
  return null
}

function resolvedIngredient(
  lineNumber: number,
  name: string,
  grams: number
): RecipeIngredientInput {
  return { id: `paste-${lineNumber}`, name, grams }
}

/** Replace one parsed ingredient line with the editor's canonical gram format. */
export function replaceRecipeIngredientLine(
  text: string,
  lineNumber: number,
  ingredient: { name: string; grams: number }
): string {
  const lines = text.split(/\r?\n/)
  const lineIndex = lineNumber - 1
  if (
    !Number.isInteger(lineNumber) ||
    lineIndex < 0 ||
    lineIndex >= lines.length
  ) {
    throw new RangeError(`Recipe line ${lineNumber} does not exist.`)
  }
  const name = ingredient.name.trim()
  if (!name || !Number.isFinite(ingredient.grams) || ingredient.grams <= 0) {
    throw new TypeError("Ingredient name and weight are required.")
  }
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n"
  lines[lineIndex] = `${formatAmount(ingredient.grams)} g ${name}`
  return lines.join(lineEnding)
}

/** Keep the entered household measure while adding an explicit weight override. */
export function replaceRecipeLineWithExplicitWeight(
  text: string,
  line: ParsedRecipeLine,
  grams: number
): string {
  if (!Number.isFinite(grams) || grams <= 0) {
    throw new TypeError("A positive ingredient weight is required.")
  }
  const lines = text.split(/\r?\n/)
  const lineIndex = line.lineNumber - 1
  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new RangeError(`Recipe line ${line.lineNumber} does not exist.`)
  }
  // A line that never carried a unit keeps none: "1 (5 g total) bouillon cube".
  const unit = line.enteredUnit ?? line.normalizedUnit
  const measure = unit
    ? `${formatAmount(line.enteredAmount)} ${unit}`
    : formatAmount(line.enteredAmount)
  lines[lineIndex] =
    `${measure} (${formatAmount(grams)} g total) ${line.ingredientName}`
  return lines.join(text.includes("\r\n") ? "\r\n" : "\n")
}

/**
 * Parse line-oriented recipe notation. Syntactically valid household measures
 * remain in `parsedLines` even when no ingredient-specific gram weight exists.
 */
export function parseRecipeText(
  text: string,
  options: ParseRecipeOptions = {}
): ParseRecipeTextResult {
  const parsedLines: ParsedRecipeLine[] = []
  const headerLines: ParsedRecipeSectionLine[] = []
  const noteLines: ParsedRecipeSectionLine[] = []
  const skippedLines: SkippedRecipeLine[] = []

  for (const [index, sourceLine] of text.split(/\r?\n/).entries()) {
    const rawLine = sourceLine.trim()
    if (!rawLine) continue
    let parseLine = normalizeVulgarFractions(normalizeLineCharacters(rawLine))
      .replace(listMarkerPattern, "")
      .trim()
    if (!parseLine) continue
    const lineNumber = index + 1

    const headingMarker = parseLine.match(headingMarkerPattern)
    if (headingMarker?.[1]) {
      headerLines.push({
        kind: "header",
        lineNumber,
        rawLine,
        text: headingMarker[1].trim(),
      })
      continue
    }
    const standaloneNote = parseLine.match(standaloneNotePattern)
    if (standaloneNote?.[1]) {
      noteLines.push({
        kind: "note",
        lineNumber,
        rawLine,
        text: standaloneNote[1].trim(),
      })
      continue
    }
    const headingLabel = parseLine.match(headingLabelPattern)
    if (headingLabel?.[1] && !amountPattern.test(parseLine)) {
      headerLines.push({
        kind: "header",
        lineNumber,
        rawLine,
        text: headingLabel[1].trim(),
      })
      continue
    }

    // A line that states its measure in front and in brackets reads as that
    // measure: "(30ml) olive oil" is 30 ml of it.
    let leadingEquivalent: { amount: number; unit: ParsedRecipeUnit } | null =
      null
    const leadingMeasure = amountPattern.test(parseLine)
      ? null
      : parseLine.match(leadingMeasurePattern)
    if (leadingMeasure) {
      const second = leadingMeasure[3]
        ? parseRecipeAmount(leadingMeasure[3])
        : null
      if (second !== null && second > 0 && leadingMeasure[4]) {
        leadingEquivalent = {
          amount: second,
          unit: normalizeUnit(leadingMeasure[4]),
        }
      }
      parseLine = `${leadingMeasure[1]} ${leadingMeasure[2]} ${leadingMeasure[5].trim()}`
    }

    if (decimalCommaPattern.test(parseLine)) {
      skippedLines.push({
        lineNumber,
        rawLine,
        reason: "Write the amount with a decimal point instead of a comma.",
        affectsPricing: true,
        kind: "unconvertible",
      })
      continue
    }

    // A written range is read at its low end and says so, because a cook who
    // wrote "3 1/2 to 4 cups" still bought flour: refusing the line lost it.
    let amountRange: ParsedRecipeLine["amountRange"] = null
    let rangeNote: string | null = null
    const rangeMatch = parseLine.match(rangePattern)
    if (rangeMatch) {
      const tail = rangeMatch[3].trim()
      const low = parseRecipeAmount(rangeMatch[1])
      const high = parseRecipeAmount(rangeMatch[2])
      const looksLikeIngredient =
        !nonIngredientRangeTailPattern.test(tail) &&
        !temperatureRangeTailPattern.test(tail)
      if (!looksLikeIngredient || low === null || low <= 0 || high === null) {
        skippedLines.push({
          lineNumber,
          rawLine,
          reason: "Choose a single ingredient amount instead of a range.",
          affectsPricing: looksLikeIngredient,
          kind: looksLikeIngredient ? "unconvertible" : "prose",
        })
        continue
      }
      amountRange = { low, high }
      const unitWord = tail.split(/\s+/)[0] ?? ""
      rangeNote = `(${rangeMatch[1].trim()}–${rangeMatch[2].trim()}${unitWord ? ` ${unitWord}` : ""})`
      parseLine = `${rangeMatch[1].trim()} ${tail}`
    }

    if (numberedInstructionPattern.test(parseLine)) {
      skippedLines.push({
        lineNumber,
        rawLine,
        reason: "Remove the step number to read this line as an ingredient.",
        affectsPricing: false,
        kind: "prose",
      })
      continue
    }

    const amountMatch = parseLine.match(amountPattern)
    const leadAmount = amountMatch?.[1]
      ? parseRecipeAmount(amountMatch[1])
      : null
    const remainder = amountMatch?.[2]?.trim() ?? ""
    let extraction: LineExtraction | null = null
    let skipReason = "Add a positive amount followed by an ingredient name."

    if (leadAmount !== null && leadAmount > 0 && remainder) {
      const unitMatch = remainder.match(supportedUnitPattern)
      const rawUnit = unitMatch?.[1] ?? null
      const ingredientName = unitMatch
        ? unitMatch[2].trim().replace(/^of\s+/i, "")
        : remainder
      if (!ingredientName) {
        skipReason = "Add an ingredient name after the amount."
      } else {
        extraction = { enteredAmount: leadAmount, rawUnit, ingredientName }
      }
    } else {
      extraction = tryNameFirst(parseLine)
    }

    if (!extraction) {
      // A recipe states plenty of real ingredients without an amount — "olive
      // oil, for brushing", "salt to taste". Those are rows the cook needs on
      // the bench; they simply never reach a price.
      const unmeasured = unmeasuredExtraction(parseLine, options)
      if (unmeasured) {
        const description = ingredientDescription(unmeasured.name)
        parsedLines.push({
          kind: "ingredient",
          lineNumber,
          rawLine,
          enteredAmount: 0,
          enteredUnit: null,
          normalizedUnit: unmeasured.unit,
          ingredientName: unmeasured.name,
          baseName: description.baseName,
          sizeWord: description.sizeWord,
          identityCandidates: description.identityCandidates,
          qualifier: description.qualifier,
          noteText: joinNotes(description.noteText, unmeasured.rest),
          note: null,
          ingredient: null,
          componentQuantity: null,
          identityMatched:
            resolveRecipeIngredientIdentity(
              unmeasured.name,
              options.identities ?? EMPTY_IDENTITIES,
              options.matches
            ) !== null,
          resolutionSource: null,
          measureRange: null,
          amountRange: null,
          equivalent: null,
          alert: "unmeasured",
        })
        continue
      }
      // An amount or a unit token means the line was aimed at the ingredient
      // list, so warn that it is excluded. A bare word gets no warning: a
      // section heading ("Filling") is indistinguishable from a nameless
      // ingredient ("Eggs"), and headings outnumber the mistake.
      const looksLikeIngredient =
        amountMatch !== null || supportedUnitPattern.test(parseLine)
      skippedLines.push({
        lineNumber,
        rawLine,
        reason: skipReason,
        // The same fact `kind` reports: a line aimed at the ingredient list
        // that could not be read is an ingredient lost from the cost, so it
        // must reach `priceRecipeBody` rather than pass as prose.
        affectsPricing: looksLikeIngredient,
        kind: looksLikeIngredient ? "unconvertible" : "prose",
      })
      continue
    }

    if (residualAmountPattern.test(extraction.ingredientName)) {
      skippedLines.push({
        lineNumber,
        rawLine,
        reason: "Combine the two amounts into one.",
        affectsPricing: true,
        kind: "unconvertible",
      })
      continue
    }

    const { enteredAmount, rawUnit } = extraction
    // "1 tsp salt:" introduces its section with the amount already written;
    // the colon is punctuation, never part of what the line names.
    let ingredientName = extraction.ingredientName.replace(/\s*:$/, "").trim()
    let normalizedUnit: ParsedRecipeUnit = rawUnit
      ? normalizeUnit(rawUnit)
      : "assumed-g"
    let ingredient: RecipeIngredientInput | null = null
    let componentQuantity: ParsedRecipeLine["componentQuantity"] = null
    let note: string | null = null
    let resolutionSource: RecipeLineResolutionSource | null = null
    let measureRange: ParsedRecipeLine["measureRange"] = null
    // The same quantity said twice — "1 cup (250 g)" — is a fact about the
    // ingredient, not two ingredients, so the second measure is kept whole.
    let equivalent: ParsedRecipeLine["equivalent"] = leadingEquivalent

    // "2 x 400 g cans …" reads `x` as a count unit, so the container weight
    // has to be reachable with that unit already matched.
    const unparenthesizedContainerWeight =
      rawUnit === null || normalizedUnit === "each"
        ? ingredientName.match(unparenthesizedContainerWeightPattern)
        : null
    if (unparenthesizedContainerWeight) {
      const packageAmount = parseRecipeAmount(unparenthesizedContainerWeight[1])
      const packageMassUnit = normalizeUnit(unparenthesizedContainerWeight[2])
      const countUnit = normalizeUnit(unparenthesizedContainerWeight[3])
      const remainingName = unparenthesizedContainerWeight[4].trim()
      if (
        packageAmount !== null &&
        isMassUnit(packageMassUnit) &&
        isCountUnit(countUnit) &&
        remainingName
      ) {
        normalizedUnit = countUnit
        ingredientName = remainingName
        ingredient = resolvedIngredient(
          lineNumber,
          ingredientName,
          massToGrams(packageAmount, packageMassUnit) * enteredAmount
        )
        note = "Used the package weight written in the recipe."
        resolutionSource = "explicit-weight"
      }
    }

    const explicitWeight = ingredientName.match(explicitWeightPattern)
    if (!ingredient && explicitWeight) {
      const explicitAmount = parseRecipeAmount(explicitWeight[1])
      const explicitUnit = normalizeUnit(explicitWeight[2])
      const explicitMarker = explicitWeight[3]?.toLowerCase() ?? null
      let remainingName = explicitWeight[4].trim()
      if (
        explicitAmount !== null &&
        isMassUnit(explicitUnit) &&
        remainingName
      ) {
        if (rawUnit === null) {
          const countMatch = remainingName.match(supportedUnitPattern)
          if (countMatch) {
            const countUnit = normalizeUnit(countMatch[1])
            const countName = countMatch[2].trim()
            if (isCountUnit(countUnit) && countName) {
              normalizedUnit = countUnit
              remainingName = countName
            }
          }
        }
        const perItem =
          enteredAmount !== 1 &&
          (explicitMarker === "each" ||
            (explicitMarker !== "total" &&
              (rawUnit === null || isCountUnit(normalizedUnit))))
        const grams =
          massToGrams(explicitAmount, explicitUnit) *
          (perItem ? enteredAmount : 1)
        ingredientName = remainingName
        if (rawUnit === null && normalizedUnit === "assumed-g") {
          normalizedUnit = "each"
        }
        ingredient = resolvedIngredient(lineNumber, ingredientName, grams)
        note = "Used the explicit weight written in the recipe."
        resolutionSource = "explicit-weight"
        equivalent = { amount: explicitAmount, unit: explicitUnit }
      }
    }

    // "1 large egg" states a size where a unit belongs: one large is one piece,
    // and the piece weight is the ingredient's own. Only a countable identity
    // reads this way — "1 large bowl" is not an egg.
    if (rawUnit === null && normalizedUnit === "assumed-g") {
      const size = ingredientName.match(sizeUnitPattern)
      const sizedName = size?.[2]?.trim() ?? ""
      const sizeUnit = size?.[1]
        ? size[1].toLowerCase().replace(/\s+/g, "-")
        : null
      if (
        sizeUnit &&
        sizedName &&
        SIZE_UNITS.has(sizeUnit) &&
        resolveRecipeIngredientIdentity(
          sizedName,
          options.identities ?? EMPTY_IDENTITIES,
          options.matches
        ) !== null &&
        measureProfile(ingredientDescription(sizedName).baseNormalized)
          ?.eachWeightG
      ) {
        normalizedUnit = sizeUnit
        ingredientName = sizedName
      }
    }

    // Settled by now, so this is the last word on what the line names.
    const description = ingredientDescription(ingredientName)
    const lineIdentity = resolveRecipeIngredientIdentity(
      ingredientName,
      options.identities ?? EMPTY_IDENTITIES,
      options.matches
    )
    // What the line says about an ingredient it named is a note about it, not
    // part of its name: "unsalted butter, cut into cubes" stocks butter.
    const writtenAbout = description.baseName.includes(",")
      ? knownIngredientPrefix(description.baseName, options)
      : null
    if (!equivalent && description.equivalentText) {
      const restated = description.equivalentText.match(
        measureAnnotationCapturePattern
      )
      const restatedAmount = restated?.[1]
        ? parseRecipeAmount(restated[1])
        : null
      if (restated?.[2] && restatedAmount !== null && restatedAmount > 0) {
        equivalent = {
          amount: restatedAmount,
          unit: normalizeUnit(restated[2]),
        }
      }
    }

    // The name the density chart answers to. Only a matched identity supplies
    // one: the written words alone say nothing about what a cup of them
    // weighs, so an unmatched line stays unweighed instead of borrowing the
    // chart's confidence.
    const weighedName = lineIdentity
      ? lineIdentity.measureName?.trim() || lineIdentity.name
      : null

    // An approximate unit's factor is a default, not a fact, so a saved
    // measure for this ingredient outranks it.
    const approximateMeasure =
      normalizedUnit !== null &&
      isApproximateUnit(normalizedUnit) &&
      isMassUnit(normalizedUnit)
        ? resolveMeasure(enteredAmount, normalizedUnit, ingredientName, options)
        : null

    if (!ingredient) {
      // "3 eggs" is a count, not three grams: reading it as a weight would be
      // less than one physical piece, so the profile's each-weight is the only
      // reading that can have been meant.
      const countedProfile =
        normalizedUnit === "assumed-g" && lineIdentity
          ? measureProfile(description.baseNormalized)
          : null
      const countedEachWeight = countedProfile?.eachWeightG
      if (
        countedProfile &&
        countedEachWeight &&
        enteredAmount < countedEachWeight
      ) {
        ingredient = resolvedIngredient(
          lineNumber,
          ingredientName,
          enteredAmount * countedEachWeight
        )
        note = `Converted using ${countedEachWeight} g per ${countedProfile.name}.`
        resolutionSource = "profile"
        normalizedUnit = "each"
      } else if (
        normalizedUnit === "g" ||
        (normalizedUnit === "assumed-g" && lineIdentity)
      ) {
        ingredient = resolvedIngredient(
          lineNumber,
          ingredientName,
          enteredAmount
        )
        note =
          normalizedUnit === "assumed-g"
            ? "No unit supplied; assumed grams."
            : null
        resolutionSource = "entered-weight"
      } else if (isMassUnit(normalizedUnit) && approximateMeasure) {
        // A pinch of saffron is not a pinch of salt, so what the kitchen saved
        // for this ingredient answers before the convention does.
        ingredient = resolvedIngredient(
          lineNumber,
          ingredientName,
          approximateMeasure.grams
        )
        note = approximateMeasure.note
        resolutionSource = approximateMeasure.source
        measureRange = approximateMeasure.range
      } else if (isMassUnit(normalizedUnit)) {
        const grams = massToGrams(enteredAmount, normalizedUnit)
        ingredient = resolvedIngredient(lineNumber, ingredientName, grams)
        note = `Converted ${enteredAmount} ${normalizedUnit} to ${formatConvertedGrams(grams)} g.`
        resolutionSource = isApproximateUnit(normalizedUnit)
          ? "approximate-unit"
          : "converted-weight"
        // A recipe writing "oz" for something we know by volume may have meant
        // fluid ounces, and the two readings differ by more than rounding, so
        // both are reported instead of silently costing the mass reading.
        const fluid =
          normalizedUnit === "oz" &&
          weighedName !== null &&
          lineIdentity?.source !== "component" &&
          lineIdentity?.conversion?.usesStandardConversion !== false
            ? densityGrams(
                enteredAmount,
                "fl-oz",
                weighedName,
                description.qualifier
              )
            : null
        if (fluid && fluid.grams !== grams) {
          measureRange = {
            lowGrams: Math.min(grams, fluid.grams),
            highGrams: Math.max(grams, fluid.grams),
            requiresReview: true,
          }
          note = `${note} An "oz" may mean fluid ounces here; confirm the weight.`
        }
      } else {
        const measure = resolveMeasure(
          enteredAmount,
          normalizedUnit,
          ingredientName,
          options
        )
        if (measure) {
          ingredient = resolvedIngredient(
            lineNumber,
            ingredientName,
            measure.grams
          )
          note = measure.note
          resolutionSource = measure.source
          measureRange = measure.range
        } else if (
          normalizedUnit === "each" ||
          SIZE_UNITS.has(normalizedUnit)
        ) {
          // Resolve a matched piece-yield component BEFORE the built-in
          // each-weight profile. A sub-recipe with a piece yield already has
          // the conversion needed for costing: one entered `ea` consumes one
          // of that component's sellable pieces, kept separate from grams
          // because a piece yield says nothing about finished weight or
          // nutrition mass. Resolving it first means a component whose title
          // collides with a profile (e.g. one named `Egg`) is still costed
          // from its piece yield instead of an invented 50 g each-weight.
          const identity = resolveRecipeIngredientIdentity(
            ingredientName,
            options.identities ?? EMPTY_IDENTITIES,
            options.matches
          )
          if (
            identity?.source === "component" &&
            identity.componentYieldUnit === "pcs" &&
            identity.componentYieldAmount !== null &&
            identity.componentYieldAmount !== undefined &&
            Number.isFinite(identity.componentYieldAmount) &&
            identity.componentYieldAmount > 0
          ) {
            componentQuantity = { amount: enteredAmount, unit: "each" }
            note = `Costed from the component's ${identity.componentYieldAmount}-piece yield.`
            resolutionSource = "component-yield"
          } else {
            const profile = lineIdentity
              ? measureProfile(description.baseNormalized)
              : null
            if (profile?.eachWeightG) {
              ingredient = resolvedIngredient(
                lineNumber,
                ingredientName,
                enteredAmount * profile.eachWeightG
              )
              note = `Converted using ${profile.eachWeightG} g per ${profile.name}.`
              resolutionSource = "profile"
            }
          }
        } else if (isVolumeUnit(normalizedUnit)) {
          // A cup of canola oil weighs what it weighs regardless of who sells
          // it, so weighing does not wait on a price. But the line is weighed
          // as the ingredient it was matched to — the one pricing will use —
          // so a match cannot weigh flour while costing oil, and an unmatched
          // name gets no weight at all rather than the chart's guess at what
          // its words might mean. A component recipe is a prepared thing whose
          // title may share a word with the chart; its weight is its own,
          // never the raw ingredient's density.
          const density =
            weighedName === null ||
            lineIdentity?.source === "component" ||
            lineIdentity?.conversion?.usesStandardConversion === false
              ? null
              : densityGrams(
                  enteredAmount,
                  normalizedUnit,
                  weighedName,
                  description.qualifier
                )
          if (density) {
            ingredient = resolvedIngredient(
              lineNumber,
              ingredientName,
              density.grams
            )
            note =
              density.rule === "standard-8oz-cup"
                ? `Converted ${enteredAmount} ${normalizedUnit} to ${formatConvertedGrams(density.grams)} g using the standard 227 g per cup estimate.`
                : `Converted ${enteredAmount} ${normalizedUnit} to ${formatConvertedGrams(density.grams)} g using a typical density.`
            resolutionSource = "density"
          }
        }
      }
    }

    parsedLines.push({
      kind: "ingredient",
      lineNumber,
      rawLine,
      enteredAmount,
      enteredUnit: rawUnit,
      // A bare number reads as grams only because a matched ingredient says
      // what it is. With nothing matched the line has no unit, which is at
      // least honest about not knowing.
      normalizedUnit:
        normalizedUnit === "assumed-g" && lineIdentity === null
          ? null
          : normalizedUnit,
      ingredientName,
      baseName: writtenAbout?.name ?? description.baseName,
      sizeWord: description.sizeWord,
      // The candidates follow the name the line ends up with, not the one
      // the vocabulary still had a clause hanging off.
      identityCandidates: writtenAbout
        ? identityCandidateNames(
            description.sizeWord
              ? writtenAbout.name.replace(
                  new RegExp(`^${description.sizeWord}\\s+`, "i"),
                  ""
                )
              : writtenAbout.name
          )
        : description.identityCandidates,
      qualifier: description.qualifier,
      // The second measure the line stated stays readable on the row: a cook
      // who wrote "(454 g)" wants to see it, and the name no longer carries it.
      noteText: joinNotes(
        description.noteText,
        writtenAbout?.rest,
        equivalent && !description.equivalentText
          ? `${formatAmount(equivalent.amount)} ${equivalent.unit}`
          : null,
        rangeNote
      ),
      note,
      ingredient,
      componentQuantity,
      identityMatched: lineIdentity !== null,
      resolutionSource,
      measureRange,
      amountRange,
      equivalent,
      alert: null,
    })
  }

  return {
    ingredients: parsedLines.flatMap((line) =>
      line.ingredient ? [line.ingredient] : []
    ),
    parsedLines,
    headerLines,
    noteLines,
    // An unmeasured line is not unresolved: nothing about it is waiting to be
    // worked out, the recipe simply never gave it an amount.
    unresolvedLines: parsedLines.filter(
      (line) =>
        line.ingredient === null &&
        line.componentQuantity === null &&
        line.alert !== "unmeasured"
    ),
    skippedLines,
  }
}
