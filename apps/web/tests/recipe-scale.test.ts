import { describe, expect, it } from "vitest"

import {
  clampScaleFactor,
  formatAppliedScaleFactor,
  formatScaleFactor,
  formatScaledAmount,
  formatScaledWeight,
  formatYieldAmount,
  MIN_SCALE_FACTOR,
  parseRecipeText,
  quantizeScaleFactor,
  scaleFactorFromYield,
  scaleFromRequestedYield,
  scaleIngredientLines,
  scaledTotalGrams,
} from "../lib/recipe"
import type { ParsedRecipeLine } from "../lib/recipe"

function line(
  fields: Pick<
    ParsedRecipeLine,
    | "lineNumber"
    | "rawLine"
    | "enteredAmount"
    | "enteredUnit"
    | "normalizedUnit"
    | "note"
    | "ingredient"
  > &
    Partial<Pick<ParsedRecipeLine, "resolutionSource" | "measureRange">>
): ParsedRecipeLine {
  return {
    kind: "ingredient",
    ingredientName: fields.ingredient?.name ?? "",
    baseName: fields.ingredient?.name ?? "",
    sizeWord: null,
    identityCandidates: [],
    qualifier: null,
    noteText: null,
    amountRange: null,
    equivalent: null,
    alert: null,
    componentQuantity: null,
    identityMatched: fields.ingredient !== null,
    resolutionSource: null,
    measureRange: null,
    ...fields,
  }
}

const gramLine = line({
  lineNumber: 1,
  rawLine: "500 gr. Bread Flour",
  enteredAmount: 500,
  enteredUnit: "gr",
  normalizedUnit: "g",
  note: null,
  ingredient: { id: "paste-1", name: "Bread Flour", grams: 500 },
})

const kilogramLine = line({
  lineNumber: 2,
  rawLine: "2 kg Water",
  enteredAmount: 2,
  enteredUnit: "kg",
  normalizedUnit: "kg",
  note: "Converted 2 kg to 2000 g.",
  ingredient: { id: "paste-2", name: "Water", grams: 2000 },
})

const ounceLine = line({
  lineNumber: 3,
  rawLine: "4 oz Butter",
  enteredAmount: 4,
  enteredUnit: "oz",
  normalizedUnit: "oz",
  note: "Converted 4 oz to 113.4 g.",
  ingredient: { id: "paste-3", name: "Butter", grams: 113.3980925 },
})

const assumedGramLine = line({
  lineNumber: 4,
  rawLine: "620 Bread Flour",
  enteredAmount: 620,
  enteredUnit: null,
  normalizedUnit: "assumed-g",
  note: "No unit supplied; assumed grams.",
  ingredient: { id: "paste-4", name: "Bread Flour", grams: 620 },
})

const eachLine = line({
  lineNumber: 5,
  rawLine: "3 each Eggs",
  enteredAmount: 3,
  enteredUnit: "each",
  normalizedUnit: "each",
  note: "Converted using 50 g per Egg.",
  ingredient: { id: "paste-5", name: "Eggs", grams: 150 },
})

const explicitWeightLine = line({
  lineNumber: 6,
  rawLine: "2 kg (1500 g total) Flour",
  enteredAmount: 2,
  enteredUnit: "kg",
  normalizedUnit: "kg",
  note: "Used the explicit weight written in the recipe.",
  ingredient: { id: "paste-6", name: "Flour", grams: 1500 },
  resolutionSource: "explicit-weight",
})

const reviewedMeasureLine = line({
  lineNumber: 7,
  rawLine: "2 cups Flour",
  enteredAmount: 2,
  enteredUnit: "cups",
  normalizedUnit: "cup",
  note: "Converted using a catalog estimate. Source range: 200–300 g; review this estimate.",
  ingredient: { id: "paste-7", name: "Flour", grams: 250 },
  resolutionSource: "catalog-measure",
  measureRange: { lowGrams: 200, highGrams: 300, requiresReview: true },
})

const estimatedMeasureLine = line({
  lineNumber: 9,
  rawLine: "1 cup Milk",
  enteredAmount: 1,
  enteredUnit: "cup",
  normalizedUnit: "cup",
  note: "Converted using a catalog estimate.",
  ingredient: { id: "paste-9", name: "Milk", grams: 240 },
  resolutionSource: "catalog-measure",
  measureRange: { lowGrams: 235, highGrams: 245, requiresReview: false },
})

const yeastLine = line({
  lineNumber: 8,
  rawLine: "1 g Yeast",
  enteredAmount: 1,
  enteredUnit: "g",
  normalizedUnit: "g",
  note: null,
  ingredient: { id: "paste-8", name: "Yeast", grams: 1 },
})

describe("scaleIngredientLines", () => {
  it("leaves every line untouched at factor 1", () => {
    expect(scaleIngredientLines([gramLine, kilogramLine, eachLine], 1)).toEqual(
      [
        {
          lineNumber: 1,
          name: "Bread Flour",
          grams: 500,
          original: { amount: 500, unit: "g" },
          measure: null,
          eachCount: null,
          countUnit: null,
          requiresReview: false,
          isEstimate: false,
          range: null,
        },
        {
          lineNumber: 2,
          name: "Water",
          grams: 2000,
          original: { amount: 2, unit: "kg" },
          measure: null,
          eachCount: null,
          countUnit: null,
          requiresReview: false,
          isEstimate: false,
          range: null,
        },
        {
          lineNumber: 5,
          name: "Eggs",
          grams: 150,
          original: null,
          measure: null,
          eachCount: 3,
          countUnit: "each",
          requiresReview: false,
          isEstimate: false,
          range: null,
        },
      ]
    )
  })

  it("shows the resolved weight, not the entered mass, when they differ", () => {
    const [atOne] = scaleIngredientLines([explicitWeightLine], 1)
    expect(atOne.grams).toBe(1500)
    expect(atOne.original).toBeNull()
    expect(formatScaledAmount(atOne, "metric")).toBe("1.5 kg")

    const [scaled] = scaleIngredientLines([explicitWeightLine], 3)
    expect(scaled.grams).toBe(4500)
    expect(scaled.original).toBeNull()
    expect(formatScaledAmount(scaled, "metric")).toBe("4.5 kg")
  })

  it("agrees with the batch total on an explicit-weight line from parsed text", () => {
    const { parsedLines } = parseRecipeText("2 kg (1500 g total) Flour")
    const [scaled] = scaleIngredientLines(parsedLines, 2)

    expect(scaled.grams).toBe(scaledTotalGrams(parsedLines, 2))
    expect(formatScaledAmount(scaled, "metric")).toBe("3 kg")
  })

  it("scales the household measure and keeps its tiny weight nonzero", () => {
    // A cup-measured line keeps the written measure beside the weight, and a
    // scaled-down weight must render sub-threshold instead of "0 g" — the
    // batch total keeps that precision, so the row cannot contradict it.
    const [scaled] = scaleIngredientLines([estimatedMeasureLine], 0.001)
    expect(scaled.measure).toEqual({ amount: 0.001, unit: "cup" })
    expect(scaled.grams).toBeCloseTo(0.24)
    expect(formatScaledWeight(scaled.grams, "metric")).not.toBe("0 g")
  })

  it("carries the measurement review flag through to the scaled line", () => {
    const [scaled] = scaleIngredientLines([reviewedMeasureLine], 2)

    expect(scaled.requiresReview).toBe(true)
    expect(scaled.grams).toBe(500)
    expect(scaled.isEstimate).toBe(true)
    expect(scaled.range).toEqual({ lowGrams: 400, highGrams: 600 })
  })

  it("marks an undisputed catalog measure as an estimate", () => {
    const [scaled] = scaleIngredientLines([estimatedMeasureLine], 2)

    expect(scaled.isEstimate).toBe(true)
    expect(scaled.requiresReview).toBe(false)
    expect(scaled.range).toEqual({ lowGrams: 470, highGrams: 490 })
  })

  it("leaves an entered weight free of estimate provenance", () => {
    const [scaled] = scaleIngredientLines([gramLine], 2)

    expect(scaled.isEstimate).toBe(false)
    expect(scaled.range).toBeNull()
  })

  it("scales parsed recipe text and keeps each line's entered unit", () => {
    const { parsedLines } = parseRecipeText("500 gr. Bread Flour\n2 kg Water")
    const scaled = scaleIngredientLines(parsedLines, 2)

    expect(scaled.map(({ grams }) => grams)).toEqual([1000, 4000])
    expect(scaled.map(({ original }) => original)).toEqual([
      { amount: 1000, unit: "g" },
      { amount: 4, unit: "kg" },
    ])
  })

  it("treats an assumed-gram line as grams", () => {
    const [scaled] = scaleIngredientLines([assumedGramLine], 0.5)

    expect(scaled.grams).toBe(310)
    expect(scaled.original).toEqual({ amount: 310, unit: "g" })
    expect(scaled.eachCount).toBeNull()
  })

  it("scales an each line as a count, not a weight", () => {
    const [scaled] = scaleIngredientLines([eachLine], 4.333)

    expect(scaled.eachCount).toBeCloseTo(12.999, 6)
    expect(scaled.grams).toBeCloseTo(649.95, 6)
    expect(scaled.original).toBeNull()
    expect(formatScaledAmount(scaled, "metric")).toBe("13 ea")

    const [half] = scaleIngredientLines([eachLine], 1.5)
    expect(formatScaledAmount(half, "us")).toBe("4.5 ea")
  })

  it("scales a count-costed component without adding invented batch weight", () => {
    const parsed = parseRecipeText("1 ea Cookie jam", {
      identities: [
        {
          id: "jam",
          name: "Cookie jam",
          normalizedName: "cookie jam",
          source: "component",
          componentYieldAmount: 60,
          componentYieldUnit: "pcs",
        },
      ],
    })
    const [scaled] = scaleIngredientLines(parsed.parsedLines, 3)

    expect(formatScaledAmount(scaled, "metric")).toBe("3 ea")
    expect(scaledTotalGrams(parsed.parsedLines, 3)).toBe(0)
  })

  it("keeps a container count counted, not weighed, when scaled", () => {
    // "2 400 g cans" resolves a real weight but a cook still counts cans, so
    // scaling by 2 reads "4 cans" rather than the 1.6 kg it weighs.
    const [line] = parseRecipeText("2 400 g cans Diced tomatoes").parsedLines
    const [scaled] = scaleIngredientLines([line], 2)

    expect(scaled.eachCount).toBe(4)
    expect(scaled.countUnit).toBe("can")
    expect(scaled.original).toBeNull()
    expect(scaled.grams).toBe(1600)
    expect(formatScaledAmount(scaled, "metric")).toBe("4 cans")
    expect(formatScaledAmount(scaled, "us")).toBe("4 cans")
  })

  it("reads a single container in the singular", () => {
    const [line] = parseRecipeText("2 400 g cans Diced tomatoes").parsedLines
    const [scaled] = scaleIngredientLines([line], 0.5)

    expect(scaled.eachCount).toBe(1)
    expect(formatScaledAmount(scaled, "metric")).toBe("1 can")
  })

  it("reads a count that only rounds to one in the singular", () => {
    // 0.999 cans displays as "1", so the label has to follow the number the
    // sheet shows rather than the raw count behind it.
    const [line] = parseRecipeText("3 400 g cans Diced tomatoes").parsedLines
    const [scaled] = scaleIngredientLines([line], 0.333)

    expect(scaled.eachCount).toBeCloseTo(0.999, 10)
    expect(formatScaledAmount(scaled, "metric")).toBe("1 can")
  })

  it("pluralizes a count that stays above one once displayed", () => {
    const [line] = parseRecipeText("3 400 g cans Diced tomatoes").parsedLines
    const [scaled] = scaleIngredientLines([line], 0.4)

    expect(scaled.eachCount).toBeCloseTo(1.2, 10)
    expect(formatScaledAmount(scaled, "metric")).toBe("1.2 cans")
  })

  it("pluralizes a fractional count well under one", () => {
    const [line] = parseRecipeText("3 400 g cans Diced tomatoes").parsedLines
    const [scaled] = scaleIngredientLines([line], 1 / 6)

    expect(formatScaledAmount(scaled, "metric")).toBe("0.5 cans")
  })

  it("pluralizes a sibilant-ending count unit with -es", () => {
    const [line] = parseRecipeText("2 250 g boxes Pasta").parsedLines
    const [scaled] = scaleIngredientLines([line], 1)

    expect(scaled.countUnit).toBe("box")
    expect(formatScaledAmount(scaled, "metric")).toBe("2 boxes")
  })

  it("carries a variety of count units through scaling", () => {
    for (const [text, unit, plural] of [
      ["3 100 g jars Honey", "jar", "jars"],
      ["2 20 g cloves Garlic", "clove", "cloves"],
      ["4 15 g bunches Basil", "bunch", "bunches"],
    ] as const) {
      const [line] = parseRecipeText(text).parsedLines
      const [scaled] = scaleIngredientLines([line], 1)
      expect(scaled.countUnit).toBe(unit)
      expect(formatScaledAmount(scaled, "metric")).toContain(plural)
    }
  })
})

describe("formatScaledAmount", () => {
  it("keeps the entered unit when it matches the viewer's system", () => {
    const [scaled] = scaleIngredientLines([kilogramLine], 2)

    expect(formatScaledAmount(scaled, "metric")).toBe("4 kg")
  })

  it("falls back to an auto-picked unit when the systems differ", () => {
    const [scaled] = scaleIngredientLines([ounceLine], 2)

    expect(formatScaledAmount(scaled, "metric")).toBe("226.8 g")
    expect(formatScaledAmount(scaled, "us")).toBe("8 oz")
  })

  it("shows a scaled-down ingredient instead of rounding it away", () => {
    const [hundredth] = scaleIngredientLines([yeastLine], 0.01)

    expect(hundredth.grams).toBeCloseTo(0.01, 12)
    expect(formatScaledAmount(hundredth, "metric")).toBe("0.01 g")
    expect(formatScaledAmount(hundredth, "us")).toBe("0.00035 oz")
  })

  it("still shows an ingredient at the smallest supported batch", () => {
    const [smallest] = scaleIngredientLines([yeastLine], MIN_SCALE_FACTOR)

    expect(formatScaledAmount(smallest, "metric")).toBe("0.001 g")
    expect(formatScaledAmount(smallest, "us")).toBe("0.000035 oz")
  })

  it("shows an each line scaled below a hundredth of a piece", () => {
    const [smallest] = scaleIngredientLines([eachLine], MIN_SCALE_FACTOR)

    expect(smallest.eachCount).toBeCloseTo(0.003, 12)
    expect(formatScaledAmount(smallest, "metric")).toBe("0.003 ea")
  })

  it("leaves ordinary amounts formatted as they were", () => {
    const [grams] = scaleIngredientLines([gramLine], 1)
    const [kilograms] = scaleIngredientLines([kilogramLine], 2)
    const [ounces] = scaleIngredientLines([ounceLine], 2)
    const [eaches] = scaleIngredientLines([eachLine], 1.5)

    expect(formatScaledAmount(grams, "metric")).toBe("500 g")
    expect(formatScaledAmount(kilograms, "metric")).toBe("4 kg")
    expect(formatScaledAmount(ounces, "us")).toBe("8 oz")
    expect(formatScaledAmount(eaches, "metric")).toBe("4.5 ea")
  })

  it("rounds a quantity the display can still show as it always did", () => {
    const [justAbove] = scaleIngredientLines([yeastLine], 0.05)
    const [belowThreshold] = scaleIngredientLines([yeastLine], 0.049)

    expect(formatScaledAmount(justAbove, "metric")).toBe("0.1 g")
    expect(formatScaledAmount(belowThreshold, "metric")).toBe("0.049 g")
  })
})

describe("scaledTotalGrams", () => {
  it("sums weight and each lines alike", () => {
    expect(scaledTotalGrams([gramLine, kilogramLine, eachLine], 2)).toBe(5300)
  })

  it("is zero for no lines", () => {
    expect(scaledTotalGrams([], 3)).toBe(0)
  })
})

describe("formatScaledWeight", () => {
  it("keeps a total under the display precision off zero", () => {
    const total = scaledTotalGrams([yeastLine], 0.01)
    const [row] = scaleIngredientLines([yeastLine], 0.01)

    expect(formatScaledWeight(total, "metric")).toBe("0.01 g")
    expect(formatScaledWeight(total, "metric")).toBe(
      formatScaledAmount(row, "metric")
    )
    expect(formatScaledWeight(total, "us")).toBe("0.00035 oz")
  })

  it("formats a total the display can show as formatWeight always did", () => {
    expect(formatScaledWeight(2500, "metric")).toBe("2.5 kg")
    expect(formatScaledWeight(0, "metric")).toBe("0 g")
  })
})

describe("scaleFactorFromYield", () => {
  it("divides the target yield by the saved yield", () => {
    const factor = scaleFactorFromYield(24, 104)

    expect(factor).toBeCloseTo(104 / 24, 12)
    expect(formatScaleFactor(factor as number)).toBe("4.333")
  })

  it("rejects a non-positive or unusable yield on either side", () => {
    expect(scaleFactorFromYield(0, 100)).toBeNull()
    expect(scaleFactorFromYield(-24, 100)).toBeNull()
    expect(scaleFactorFromYield(Number.NaN, 100)).toBeNull()
    expect(scaleFactorFromYield(24, 0)).toBeNull()
    expect(scaleFactorFromYield(24, -100)).toBeNull()
    expect(scaleFactorFromYield(24, Number.NaN)).toBeNull()
  })
})

describe("clampScaleFactor", () => {
  it("rejects anything that is not a positive number", () => {
    expect(clampScaleFactor(0)).toBeNull()
    expect(clampScaleFactor(-1)).toBeNull()
    expect(clampScaleFactor(Number.NaN)).toBeNull()
    expect(clampScaleFactor(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it("formats a clamped maximum without grouping for the number input", () => {
    expect(formatScaleFactor(clampScaleFactor(1e9) as number)).toBe("1000")
  })

  it("clamps into the supported range", () => {
    expect(clampScaleFactor(1e9)).toBe(1000)
    expect(clampScaleFactor(1e-9)).toBe(0.001)
    expect(clampScaleFactor(1)).toBe(1)
  })
})

describe("quantizeScaleFactor", () => {
  it("commits exactly what the batch field displays", () => {
    for (const typed of [0.0014, 4.3333333, 1 / 3, 1000, 0.001, 1]) {
      const committed = quantizeScaleFactor(clampScaleFactor(typed) as number)
      expect(Number.parseFloat(formatScaleFactor(committed))).toBe(committed)
    }
  })

  it("keeps a factor below the displayed precision inside the supported range", () => {
    expect(quantizeScaleFactor(0.0014)).toBe(0.001)
    expect(formatScaleFactor(quantizeScaleFactor(0.0014))).toBe("0.001")
  })

  it("leaves a factor the formatter already shows exactly alone", () => {
    expect(quantizeScaleFactor(2.5)).toBe(2.5)
    expect(quantizeScaleFactor(1000)).toBe(1000)
  })
})

describe("formatYieldAmount", () => {
  it("hides float dust from a round trip through the scale factor", () => {
    expect(formatYieldAmount(24 * (104 / 24))).toBe("104")
    expect(formatYieldAmount(2 * 4.333)).toBe("8.666")
  })

  it("keeps a small saved yield exact instead of rounding it", () => {
    expect(formatYieldAmount(0.125)).toBe("0.125")
  })

  it("still shows the smallest yield the minimum batch can reach", () => {
    expect(formatYieldAmount(0.000001 * MIN_SCALE_FACTOR)).toBe("0.000000001")
  })

  it("leaves thousands ungrouped for the number input", () => {
    expect(formatYieldAmount(2000)).toBe("2000")
  })
})

type ScaleControlsState = { factor: number; batch: string; yield: string }

/**
 * The two linked controls of the scaled view, reduced to the state each blur
 * commits: whichever field was typed into owns the factor, the other is the
 * readout derived from it.
 */
function scaleControls(savedYield: number) {
  let factor = 1
  let yieldDisplay = formatYieldAmount(savedYield)

  const state = (): ScaleControlsState => ({
    factor,
    batch: formatAppliedScaleFactor(factor),
    yield: yieldDisplay,
  })

  return {
    state,
    commitBatch(typed: string): ScaleControlsState {
      const parsed = clampScaleFactor(Number.parseFloat(typed))
      if (parsed !== null) factor = quantizeScaleFactor(parsed)
      yieldDisplay = formatYieldAmount(savedYield * factor)
      return state()
    },
    commitYield(typed: string): ScaleControlsState {
      const committed = scaleFromRequestedYield(
        savedYield,
        Number.parseFloat(typed)
      )
      if (committed !== null) {
        factor = committed.factor
        yieldDisplay = formatYieldAmount(committed.yieldAmount)
      }
      return state()
    },
  }
}

describe("committing a scale from either control", () => {
  it("keeps a typed yield the batch field cannot spell in three decimals", () => {
    const controls = scaleControls(1000)

    const committed = controls.commitYield("1.5")

    expect(committed.factor).toBe(0.0015)
    expect(committed.yield).toBe("1.5")
    expect(committed.batch).toBe("0.0015")
    expect(scaledTotalGrams([gramLine], committed.factor)).toBeCloseTo(0.75, 12)
  })

  it("still commits a typed batch factor as the batch field displays it", () => {
    const controls = scaleControls(1000)

    const committed = controls.commitBatch("0.0014")

    expect(committed.factor).toBe(0.001)
    expect(committed.batch).toBe("0.001")
    expect(committed.yield).toBe("1")
  })

  it("round trips an ordinary yield change back to the yield asked for", () => {
    const controls = scaleControls(24)

    const committed = controls.commitYield("104")

    expect(committed.factor).toBeCloseTo(104 / 24, 12)
    expect(committed.batch).toBe("4.33333333333333")
    expect(committed.yield).toBe("104")
    expect(controls.commitBatch("2").yield).toBe("48")
    expect(controls.commitYield("12").factor).toBe(0.5)
  })

  it("leaves the last committed factor alone when the input is unusable", () => {
    const controls = scaleControls(1000)
    const committed = controls.commitYield("1.5")

    expect(controls.commitYield("").factor).toBe(committed.factor)
    expect(controls.commitBatch("0.").factor).toBe(committed.factor)
    expect(controls.state().yield).toBe("1.5")
  })

  it("shows the clamped yield when the request is out of range", () => {
    const controls = scaleControls(1000)

    const committed = controls.commitYield("0.0000001")

    expect(committed.factor).toBe(MIN_SCALE_FACTOR)
    expect(committed.yield).toBe("1")
  })
})
