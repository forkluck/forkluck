import chart from "../../../../data/volume-measures.json"

import { MILLILITERS_PER_UNIT } from "./volume"

const MILLILITERS_PER_CUP = MILLILITERS_PER_UNIT.cup
const STANDARD_GRAMS_PER_CUP = chart.standardGramsPerCup
const STANDARD_RULE = "standard-8oz-cup"

type DensityRule = {
  key: string
  match: string[]
  exclude?: string[]
  categories?: string[]
  /** Product forms a descriptor-named rule may end on, e.g. cocoa "powder". */
  endings?: string[]
  gramsPerCup: number
}

const RULES: DensityRule[] = chart.rules

/** Whole-word match, so "honey" does not read out of "honeycrisp apples". */
function containsPhrase(words: string[], phrase: string): boolean {
  const terms = phrase.split(" ")
  return words.some((_, start) =>
    terms.every((term, offset) => words[start + offset] === term)
  )
}

/** The phrase the name ends on, which is the ingredient it names. */
function endsWithPhrase(words: string[], phrase: string): boolean {
  const terms = phrase.split(" ")
  const start = words.length - terms.length
  return (
    start >= 0 && terms.every((term, offset) => words[start + offset] === term)
  )
}

function ruleFor(name: string): DensityRule | null {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return null
  for (const rule of RULES) {
    if (!rule.match.every((term) => containsPhrase(words, term))) continue
    if (rule.exclude?.some((term) => containsPhrase(words, term))) continue
    // The name has to end on the product the rule names, or "sugar snap
    // peas" reads as sugar and "peanut butter powder" as the paste. A rule
    // whose match term is a descriptor lists its product forms in `endings`.
    if (
      !(rule.endings ?? rule.match).some((term) => endsWithPhrase(words, term))
    )
      continue
    return rule
  }
  return null
}

/**
 * What a volume of this ingredient weighs, from its name alone.
 *
 * A cup of canola oil weighs the same whoever sells it, so this deliberately
 * never consults the catalog: knowing what something weighs must not wait on
 * knowing what it costs. A loose name match is right here and wrong for
 * pricing — every canola oil shares a density, none share a price.
 *
 * Every rule and the standard estimate describe the ingredient in its plain
 * state, so a parsed preparation or packing qualifier has no compatible
 * answer and stays unresolved. A known density wins; a matched ingredient the
 * chart does not know uses the visible 8 oz-weight-per-cup convention.
 */
export function densityGrams(
  amount: number,
  unit: string,
  name: string,
  qualifier: string | null = null
): { grams: number; rule: string } | null {
  if (qualifier) return null
  const rule = ruleFor(name)
  const milliliters = amount * MILLILITERS_PER_UNIT[unit]
  if (!Number.isFinite(milliliters)) return null
  return {
    grams:
      (milliliters / MILLILITERS_PER_CUP) *
      (rule?.gramsPerCup ?? STANDARD_GRAMS_PER_CUP),
    rule: rule?.key ?? STANDARD_RULE,
  }
}
