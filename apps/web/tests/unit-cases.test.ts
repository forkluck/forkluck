import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  batchUnitOptions,
  conversionUnitOptions,
  countedAsEach,
  displayUnitShort,
  formatPackSize,
  isPackUnit,
  isProductUnit,
  normalizePackUnit,
  packUnitGroups,
  productUnitOptions,
  purchaseUnitOptions,
  recipeUnitOptions,
  servingUnitOptions,
  UNIT_CATALOG,
  unitDefinition,
  unitLabel,
  unitRatio,
  unitShort,
  unitWord,
  yieldUnitOptions,
} from "@/lib/unit-registry"
import { displayWeight, formatWeight } from "@/lib/units"
import type { WeightSystem } from "@/lib/units"

/**
 * The unit registry, pinned as data for the Mac app.
 *
 * `tests/fixtures/unit-cases.json` is generated from the functions below and
 * copied verbatim into the Mac app (`forkluck-macosTests/Fixtures/`), whose
 * Swift port of the registry asserts every case. Regenerate with
 * `UPDATE_UNIT_FIXTURE=1 pnpm exec vitest run tests/unit-cases.test.ts` and
 * copy it across.
 */

const FIXTURE = new URL("./fixtures/unit-cases.json", import.meta.url)
const GENERATOR =
  "cd apps/web && UPDATE_UNIT_FIXTURE=1 pnpm exec vitest run tests/unit-cases.test.ts"

/** Every catalog slug, the yield's own "pcs", and one imported unknown. */
const SLUGS = [...UNIT_CATALOG.map((unit) => unit.slug), "pcs", "bushel"]

/** Inputs from unit-registry.test.ts, then the spellings an invoice prints. */
const PACK_WORDS = [
  "LB",
  "lbs.",
  "OZ",
  "FL OZ",
  "ML",
  "GAL",
  "CS",
  "CASE",
  "CAN",
  "BOTTLE",
  "CARTON",
  "PK",
  "BAG",
  "BOX",
  "JAR",
  "BUNCH",
  "CT",
  "COUNT",
  "PCS",
  "EA",
  "EACH",
  "DZ",
  "X",
  "bushel",
  "  ",
  "",
  "x",
  "×",
  "Pound",
  "pounds",
  "fl. oz",
  "fl  oz",
  "gallon",
  "liters",
  "Litre",
  "kg.",
  "KG",
  "g",
  "grams",
  "DOZEN",
  "PKG",
  "cnt",
  "Each",
  "Bottles",
  "cans",
  "tbsp",
  "cup",
  "Cups",
  "Qt",
  "PT",
  "pint",
  "quart",
  "Jars",
]

const PACK_AMOUNTS = [1, 0.5, 2.5, 12, 1000, 1234.5678, 0.12345, null]
const SYSTEMS: WeightSystem[] = ["metric", "us"]

const WEIGHT_GRAMS = [
  0, 0.4, 12.345, 28.349523125, 453.59237, 999.9, 1000, 1234.5, 2500,
]

/** batchUnitOptions inputs from unit-registry.test.ts. */
const BATCHES: Parameters<typeof batchUnitOptions>[0][] = [
  {
    batchMeasures: [
      { amount: 20, unit: "kg" },
      { amount: 40, unit: "pcs" },
    ],
    servingAmount: null,
    servingUnit: null,
  },
  {
    batchMeasures: [{ amount: 5, unit: "kg" }],
    servingAmount: 250,
    servingUnit: "g",
  },
  {
    batchMeasures: [
      { amount: 5, unit: "kg" },
      { amount: 10, unit: "portion" },
    ],
    servingAmount: null,
    servingUnit: null,
  },
  { batchMeasures: [], servingAmount: null, servingUnit: null },
  {
    batchMeasures: [
      { amount: 2, unit: "l" },
      { amount: 8, unit: "slice" },
    ],
    servingAmount: 1,
    servingUnit: "slice",
  },
]

function generate() {
  return {
    generator: GENERATOR,
    units: [...SLUGS, null].map((slug) => ({
      slug,
      definition: unitDefinition(slug),
      label: unitLabel(slug),
      short: unitShort(slug),
      displayShort: displayUnitShort(slug),
      word: unitWord(slug),
      countedAsEach: countedAsEach(slug),
      isPackUnit: isPackUnit(slug),
      isProductUnit: isProductUnit(slug),
    })),
    ratios: SLUGS.flatMap((from) =>
      SLUGS.map((to) => ({ from, to, ratio: unitRatio(from, to) }))
    ),
    normalizePackUnit: PACK_WORDS.map((word) => ({
      word,
      expect: normalizePackUnit(word),
    })),
    formatPackSize: [...SLUGS, null].flatMap((unit) =>
      PACK_AMOUNTS.flatMap((amount) =>
        SYSTEMS.map((system) => ({
          amount,
          unit,
          system,
          expect: formatPackSize(amount, unit, system),
        }))
      )
    ),
    displayWeight: WEIGHT_GRAMS.flatMap((grams) =>
      SYSTEMS.map((system) => ({
        grams,
        system,
        expect: displayWeight(grams, system),
      }))
    ),
    formatWeight: WEIGHT_GRAMS.flatMap((grams) =>
      SYSTEMS.flatMap((system) =>
        [0, 1].map((decimals) => ({
          grams,
          system,
          decimals,
          expect: formatWeight(grams, system, undefined, decimals),
        }))
      )
    ),
    options: {
      recipe: recipeUnitOptions(),
      yield: yieldUnitOptions(),
      serving: servingUnitOptions(),
      purchase: purchaseUnitOptions(),
      packGroups: packUnitGroups(),
      product: productUnitOptions(),
      conversion: conversionUnitOptions(),
    },
    batchUnitOptions: BATCHES.map((recipe) => ({
      recipe,
      expect: batchUnitOptions(recipe),
    })),
  }
}

describe("the unit fixture the Mac app asserts against", () => {
  it("matches what the unit registry answers", () => {
    const generated = JSON.parse(JSON.stringify(generate()))
    if (process.env.UPDATE_UNIT_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
