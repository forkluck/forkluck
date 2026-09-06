import { tidyVolume } from "@/lib/recipe"
import { describe, expect, it } from "vitest"

import corpus from "./fixtures/recipe-lines.json"
import vocabulary from "../../../data/parser-vocabulary.json"

import { INGREDIENT_PROFILES } from "../lib/recipe/data"

import {
  analyzeRecipe,
  clampRecipeQuantity,
  findIngredientProfile,
  parseRecipeText,
  replaceRecipeIngredientLine,
  replaceRecipeLineWithExplicitWeight,
  type IngredientMeasure,
  type RecipeIngredientIdentity,
} from "../lib/recipe"

// Measure units a recipe can be written in using the slug itself. A case and
// the hotel pans carry no pattern at all, and `dry-pint` or `heaping-tsp` are
// written as words rather than as their slug.
const PARSEABLE_MEASURE_UNITS = vocabulary.units
  .filter(
    (unit) =>
      (unit.family === "volume" || unit.family === "count") &&
      unit.pattern &&
      new RegExp(`^(?:${unit.pattern})$`, "i").test(unit.slug)
  )
  .map((unit) => unit.slug)

const flourCup: IngredientMeasure = {
  id: "catalog-flour-cup",
  ingredientId: null,
  name: "All-purpose flour",
  normalizedName: "all purpose flour",
  unit: "cup",
  amount: 1,
  grams: 125,
  lowGrams: null,
  highGrams: null,
  qualifier: "",
  source: "catalog",
  confidence: "high",
}

/**
 * Pantry identities for these names. A line only reaches a weight it did not
 * state in words when its name matched something the kitchen actually has, so
 * most weighing tests have to hand the parser the ingredients first.
 */
function pantry(...names: string[]): RecipeIngredientIdentity[] {
  return names.map((name) => ({
    id: `pantry-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    normalizedName: name
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim(),
    source: "pantry" as const,
  }))
}

const chefRecipe = `500 gr. Bread Flour
380 gr. Warm Water
40 gr. Extra Virgin Olive Oil
10 gr. Fine Sea Salt
5 gr. Instant Yeast
8 gr. Honey
120 gr. Cherry Tomatoes
4 gr. Fresh Rosemary`

describe("recipe paste parser", () => {
  it("parses a line-oriented chef recipe and analyzes the batch", () => {
    const result = parseRecipeText(chefRecipe)

    expect(result.skippedLines).toEqual([])
    expect(result.ingredients).toEqual([
      { id: "paste-1", name: "Bread Flour", grams: 500 },
      { id: "paste-2", name: "Warm Water", grams: 380 },
      { id: "paste-3", name: "Extra Virgin Olive Oil", grams: 40 },
      { id: "paste-4", name: "Fine Sea Salt", grams: 10 },
      { id: "paste-5", name: "Instant Yeast", grams: 5 },
      { id: "paste-6", name: "Honey", grams: 8 },
      { id: "paste-7", name: "Cherry Tomatoes", grams: 120 },
      { id: "paste-8", name: "Fresh Rosemary", grams: 4 },
    ])

    const analysis = analyzeRecipe(result.ingredients, "bread")
    expect(analysis.totalMassG).toBe(1067)
    expect(analysis.coveragePercent).toBe(100)
    expect(analysis.flourMassG).toBe(500)
    expect(analysis.signals.find(({ key }) => key === "hydration")).toEqual(
      expect.objectContaining({ value: 76, status: "balanced" })
    )
    expect(analysis.signals.find(({ key }) => key === "salt")).toEqual(
      expect.objectContaining({ value: 2, status: "balanced" })
    )
  })

  it("reads a unitless leading amount as grams once the name is known", () => {
    const result = parseRecipeText("620 Bread Flour", {
      identities: pantry("Bread Flour"),
    })

    expect(result.ingredients).toEqual([
      { id: "paste-1", name: "Bread Flour", grams: 620 },
    ])
    expect(result.parsedLines[0]).toEqual(
      expect.objectContaining({
        enteredUnit: null,
        normalizedUnit: "assumed-g",
        note: "No unit supplied; assumed grams.",
      })
    )
  })

  it("gives an unmatched name no weight and no unit", () => {
    // The issue: "1 chicken bouillon cube" is not one gram of anything, and a
    // tablespoon of a flour nobody stocks is not 7.8 g. Both lines stay
    // parsed — the amount and the name are still what the cook wrote — but
    // neither claims a weight.
    const result = parseRecipeText(
      "1 chicken bouillon cube\n1 tbsp all purpose flour\n3 eggs"
    )

    expect(result.ingredients).toEqual([])
    expect(result.skippedLines).toEqual([])
    expect(
      result.parsedLines.map((line) => ({
        name: line.ingredientName,
        amount: line.enteredAmount,
        unit: line.normalizedUnit,
        identityMatched: line.identityMatched,
        resolutionSource: line.resolutionSource,
      }))
    ).toEqual([
      {
        name: "chicken bouillon cube",
        amount: 1,
        unit: null,
        identityMatched: false,
        resolutionSource: null,
      },
      {
        name: "all purpose flour",
        amount: 1,
        unit: "tbsp",
        identityMatched: false,
        resolutionSource: null,
      },
      {
        name: "eggs",
        amount: 3,
        unit: null,
        identityMatched: false,
        resolutionSource: null,
      },
    ])
    expect(result.unresolvedLines).toHaveLength(3)
  })

  it("converts kilograms and accepts common gram spellings", () => {
    const result = parseRecipeText(
      "1.5 kg Flour\n20 grams Sugar\n5 g. Salt\n0.25 kilogram Butter\n3 gram Vanilla"
    )

    expect(result.ingredients.map(({ grams }) => grams)).toEqual([
      1500, 20, 5, 250, 3,
    ])
    expect(result.parsedLines[0]?.note).toBe("Converted 1.5 kg to 1500 g.")
    expect(result.parsedLines[3]?.enteredUnit).toBe("kilogram")
  })

  it.each(["2 ea Eggs", "2 each Eggs", "2 x Eggs", "2x Eggs"])(
    "accepts the each-unit spelling in %s",
    (line) => {
      expect(
        parseRecipeText(line, { identities: pantry("Eggs") }).ingredients[0]
          ?.grams
      ).toBe(100)
    }
  )

  it.each(["1 ea Cookie dough", "1 each Cookie dough", "1x Cookie dough"])(
    "cost-resolves a piece-yield component without inventing weight in %s",
    (line) => {
      const result = parseRecipeText(line, {
        identities: [
          {
            id: "component-dough",
            name: "Cookie dough",
            normalizedName: "cookie dough",
            source: "component",
            componentYieldAmount: 70,
            componentYieldUnit: "pcs",
          },
        ],
      })

      expect(result.unresolvedLines).toEqual([])
      expect(result.ingredients).toEqual([])
      expect(result.parsedLines[0]).toEqual(
        expect.objectContaining({
          componentQuantity: { amount: 1, unit: "each" },
          resolutionSource: "component-yield",
        })
      )
    }
  )

  it.each(["Egg", "Eggs", "Large egg", "Whole egg"])(
    "prefers a piece-yield component over the built-in each-weight profile for %s",
    (title) => {
      // Each of these titles collides with the built-in 50 g egg profile.
      // A matched piece-yield component must be resolved first, so the line
      // is costed from the component's piece yield rather than 50 g.
      const result = parseRecipeText(`1 ea ${title}`, {
        identities: [
          {
            id: "component-egg",
            name: title,
            normalizedName: title.toLowerCase(),
            source: "component",
            componentYieldAmount: 70,
            componentYieldUnit: "pcs",
          },
        ],
      })

      expect(result.unresolvedLines).toEqual([])
      expect(result.ingredients).toEqual([])
      expect(result.parsedLines[0]).toEqual(
        expect.objectContaining({
          componentQuantity: { amount: 1, unit: "each" },
          resolutionSource: "component-yield",
        })
      )
    }
  )

  it("still applies the built-in each-weight profile when no component matches Egg", () => {
    // Guard the fallback: with the pantry's Eggs matched but no component of
    // that name, the 50 g profile stands.
    const result = parseRecipeText("2 ea Eggs", {
      identities: pantry("Eggs"),
    })

    expect(result.ingredients[0]).toEqual(
      expect.objectContaining({ name: "Eggs", grams: 100 })
    )
    expect(result.parsedLines[0].resolutionSource).toBe("profile")
  })

  it("keeps an each line unresolved when the component has no piece yield", () => {
    const result = parseRecipeText("1 ea Cookie dough", {
      identities: [
        {
          id: "component-dough",
          name: "Cookie dough",
          normalizedName: "cookie dough",
          source: "component",
        },
      ],
    })

    expect(result.unresolvedLines).toHaveLength(1)
  })

  it.each(["room temperature", "divided"])(
    "keeps the each-weight fallback through a %s annotation",
    (annotation) => {
      const result = parseRecipeText(`2 each Eggs (${annotation})`, {
        identities: pantry("Eggs"),
      })

      expect(result.unresolvedLines).toEqual([])
      expect(result.ingredients[0]).toEqual(
        expect.objectContaining({ name: `Eggs (${annotation})`, grams: 100 })
      )
    }
  )

  it("keeps valid unresolved measures separate from malformed lines", () => {
    const result = parseRecipeText(
      "Eggs\n2 cups Flour\n3 ea Rosemary\n0 g Salt\n\n12 gr. Sugar",
      { identities: pantry("Flour", "Rosemary") }
    )

    // "Eggs" names an ingredient the kitchen knows and no amount, so it is a
    // row waiting for a quantity rather than a line the paste threw away.
    expect(result.skippedLines).toEqual([
      expect.objectContaining({ lineNumber: 4, rawLine: "0 g Salt" }),
    ])
    expect(
      result.parsedLines.map(({ rawLine, alert }) => ({ rawLine, alert }))
    ).toContainEqual({ rawLine: "Eggs", alert: "unmeasured" })
    // Flour weighs itself from a typical density; a count of a profile with
    // no each-weight cannot.
    expect(result.ingredients.map((item) => item.name)).toEqual([
      "Flour",
      "Sugar",
    ])
    expect(result.unresolvedLines).toEqual([
      expect.objectContaining({
        lineNumber: 3,
        ingredientName: "Rosemary",
        normalizedUnit: "each",
      }),
    ])
  })

  it("weighs a dash from its volume until a measure says otherwise", () => {
    const dashMeasure: IngredientMeasure = {
      ...flourCup,
      id: "salt-dash",
      name: "Salt",
      normalizedName: "salt",
      unit: "dash",
      grams: 0.6,
    }

    const convention = parseRecipeText("1 dash Salt", {
      identities: pantry("Salt"),
    })
    expect(convention.unresolvedLines).toEqual([])
    expect(convention.ingredients[0].grams).toBeGreaterThan(0)

    const resolved = parseRecipeText("1 dash Salt", {
      measures: [dashMeasure],
    })
    expect(resolved.ingredients[0]).toEqual(
      expect.objectContaining({ name: "Salt", grams: 0.6 })
    )
    expect(resolved.parsedLines[0].resolutionSource).toBe("catalog-measure")
  })

  it("costs a pinch off the convention until a measure says otherwise", () => {
    const saffron: IngredientMeasure = {
      ...flourCup,
      id: "saffron-pinch",
      name: "Saffron",
      normalizedName: "saffron",
      unit: "pinch",
      grams: 0.05,
      source: "user",
    }

    const convention = parseRecipeText("1 pinch Salt")
    expect(convention.parsedLines[0].resolutionSource).toBe("approximate-unit")
    expect(convention.ingredients[0].grams).toBeCloseTo(0.2835, 4)

    const saved = parseRecipeText("1 pinch Saffron", { measures: [saffron] })
    expect(saved.parsedLines[0].resolutionSource).toBe("user-measure")
    expect(saved.ingredients[0].grams).toBe(0.05)
  })

  it.each(PARSEABLE_MEASURE_UNITS)(
    "recognizes the canonical %s unit with comma punctuation",
    (unit) => {
      const measure: IngredientMeasure = {
        ...flourCup,
        id: `test-${unit}`,
        name: "Test ingredient",
        normalizedName: "test ingredient",
        unit,
        grams: 25,
      }
      const result = parseRecipeText(`1 ${unit}, Test ingredient`, {
        measures: [measure],
      })

      expect(result.skippedLines).toEqual([])
      expect(result.parsedLines[0]).toEqual(
        expect.objectContaining({
          normalizedUnit: unit,
          ingredientName: "Test ingredient",
        })
      )
      expect(result.ingredients[0].grams).toBe(25)
    }
  )

  it.each([
    ["1 fl. oz. Test ingredient", "fl-oz"],
    ["1 fluid ounce Test ingredient", "fl-oz"],
    ["1 tablespoon Test ingredient", "tbsp"],
    ["1 tsp. Test ingredient", "tsp"],
    ["1 millilitre Test ingredient", "ml"],
    ["1 litre Test ingredient", "l"],
    ["1 tin Test ingredient", "can"],
    ["1 package Test ingredient", "packet"],
    ["1 pinch Test ingredient", "pinch"],
    ["1 bunch Test ingredient", "bunch"],
  ] as const)("normalizes the unit alias in %s", (line, unit) => {
    const result = parseRecipeText(line)

    expect(result.parsedLines[0]).toEqual(
      expect.objectContaining({
        normalizedUnit: unit,
        ingredientName: "Test ingredient",
      })
    )
  })

  it("accepts copied-list bullets and an optional of connector", () => {
    const result = parseRecipeText(
      "• 1 cup of All-purpose flour\n- 1 cup of All-purpose flour",
      { measures: [flourCup] }
    )

    expect(result.ingredients).toEqual([
      { id: "paste-1", name: "All-purpose flour", grams: 125 },
      { id: "paste-2", name: "All-purpose flour", grams: 125 },
    ])
  })

  it("converts ounces and pounds to grams", () => {
    const result = parseRecipeText(
      "1 lb Butter\n8 oz Sugar\n2 pounds Bread Flour\n4 ozs. Honey"
    )

    expect(result.skippedLines).toEqual([])
    expect(result.parsedLines[0].normalizedUnit).toBe("lb")
    expect(result.parsedLines[0].ingredient?.grams).toBeCloseTo(453.59237, 5)
    expect(result.parsedLines[0].note).toBe("Converted 1 lb to 453.6 g.")
    expect(result.parsedLines[1].normalizedUnit).toBe("oz")
    expect(result.parsedLines[1].ingredient?.grams).toBeCloseTo(226.796185, 5)
    expect(result.parsedLines[2].ingredient?.grams).toBeCloseTo(907.18474, 5)
    expect(result.parsedLines[3].ingredient?.grams).toBeCloseTo(113.398093, 5)
  })

  it("reads name-first spreadsheet lines with and without units", () => {
    const result = parseRecipeText(
      "butter 810\npowder sugar 200\nap flour\tgr\t1000\nkosher salt    14\nsugar 210 g",
      { identities: pantry("butter", "powder sugar", "kosher salt") }
    )

    expect(result.skippedLines).toEqual([])
    expect(result.ingredients).toEqual([
      { id: "paste-1", name: "butter", grams: 810 },
      { id: "paste-2", name: "powder sugar", grams: 200 },
      { id: "paste-3", name: "ap flour", grams: 1000 },
      { id: "paste-4", name: "kosher salt", grams: 14 },
      { id: "paste-5", name: "sugar", grams: 210 },
    ])
    expect(result.parsedLines[0].normalizedUnit).toBe("assumed-g")
    expect(result.parsedLines[2].normalizedUnit).toBe("g")
  })

  it("replaces an edited ingredient without changing the other recipe lines", () => {
    const recipe = "30 g puffed millet\r\n360 g peanuts\r\nBake until crisp."

    expect(
      replaceRecipeIngredientLine(recipe, 2, {
        name: "unsalted peanuts",
        grams: 375.5,
      })
    ).toBe(
      "30 g puffed millet\r\n375.5 g unsalted peanuts\r\nBake until crisp."
    )
  })

  it("does not mistake method text for name-first ingredients", () => {
    const result = parseRecipeText(
      "oven to 175\nbake 12 minutes\nrest the dough for 30\nbake until 20"
    )
    expect(result.ingredients).toEqual([])
    expect(result.skippedLines).toHaveLength(4)
  })

  it("recognizes name-first volume lines before their weights are known", () => {
    const result = parseRecipeText("mystery ml 200\ncream 200 ml")
    expect(result.ingredients).toEqual([])
    expect(result.skippedLines).toEqual([])
    expect(result.unresolvedLines.map((line) => line.normalizedUnit)).toEqual([
      "ml",
      "ml",
    ])
  })

  it("resolves cups and derived metric volumes with ingredient measures", () => {
    const result = parseRecipeText(
      "2 cups All-purpose flour\n118.29411825 ml All-purpose flour",
      { measures: [flourCup] }
    )

    expect(result.unresolvedLines).toEqual([])
    expect(result.ingredients[0].grams).toBe(250)
    expect(result.ingredients[1].grams).toBeCloseTo(62.5, 6)
    expect(result.parsedLines[0].resolutionSource).toBe("catalog-measure")
  })

  it("lets a user measure beat a shared estimate through a saved match", () => {
    const userMeasure: IngredientMeasure = {
      ...flourCup,
      id: "user-flour",
      ingredientId: "pantry-flour",
      grams: 130,
      source: "user",
    }
    const result = parseRecipeText("1 cup AP flour", {
      matches: [{ line: "ap flour", targetId: "pantry-flour" }],
      measures: [flourCup, userMeasure],
    })

    expect(result.ingredients[0].grams).toBe(130)
    expect(result.parsedLines[0].resolutionSource).toBe("user-measure")
  })

  it("uses a shared default for the canonical target of a saved match", () => {
    const result = parseRecipeText("1 cup AP flour", {
      matches: [
        {
          line: "ap flour",
          targetId: "pantry-flour",
          targetName: "All-purpose flour",
          targetKind: "ingredient",
        },
      ],
      measures: [flourCup],
    })

    expect(result.ingredients[0].grams).toBe(125)
    expect(result.parsedLines[0].resolutionSource).toBe("catalog-measure")
  })

  it("does not cross a match target to a different shared default", () => {
    const result = parseRecipeText("1 cup AP flour", {
      identities: pantry("Bread Flour"),
      matches: [
        {
          line: "ap flour",
          targetId: "pantry-bread-flour",
          targetName: "Bread Flour",
          targetKind: "ingredient",
        },
      ],
      measures: [flourCup],
    })

    // 125 g would mean it borrowed the catalog's All-purpose flour cup; 127
    // is the chart's own reading of Bread Flour, the ingredient this line was
    // matched to, which is the whole point.
    expect(result.parsedLines[0].resolutionSource).toBe("density")
    expect(result.parsedLines[0].ingredient?.grams).toBeCloseTo(127, 0)
  })

  it("does not cross a match target to use another pantry measure", () => {
    const otherPantryMeasure: IngredientMeasure = {
      ...flourCup,
      id: "other-pantry-flour",
      ingredientId: "pantry-all-purpose-flour",
      source: "user",
    }
    const result = parseRecipeText("1 cup AP flour", {
      identities: pantry("Bread Flour"),
      matches: [{ line: "ap flour", targetId: "pantry-bread-flour" }],
      measures: [otherPantryMeasure],
    })

    expect(result.parsedLines[0]).toEqual(
      expect.objectContaining({
        ingredientName: "AP flour",
        normalizedUnit: "cup",
        resolutionSource: "density",
      })
    )
  })

  it("uses the base ingredient match for a qualified saved measure", () => {
    const siftedSugar: IngredientMeasure = {
      ...flourCup,
      id: "sifted-sugar",
      ingredientId: "pantry-sugar",
      name: "Confectioners sugar",
      normalizedName: "confectioners sugar",
      grams: 110,
      qualifier: "sifted",
      source: "user",
    }
    const result = parseRecipeText("1 cup Powdered sugar, sifted", {
      matches: [{ line: "powdered sugar", targetId: "pantry-sugar" }],
      measures: [siftedSugar],
    })

    expect(result.ingredients[0].grams).toBe(110)
    expect(result.parsedLines[0]).toEqual(
      expect.objectContaining({
        ingredientName: "Powdered sugar, sifted",
        qualifier: "sifted",
        resolutionSource: "user-measure",
      })
    )
  })

  it("keeps an unpunctuated preparation word in the ingredient identity", () => {
    const choppedOnions: IngredientMeasure = {
      ...flourCup,
      id: "chopped-onions",
      name: "Onions",
      normalizedName: "onions",
      grams: 160,
      qualifier: "chopped",
    }
    const result = parseRecipeText("1 cup chopped Onions", {
      measures: [choppedOnions],
    })

    expect(result.parsedLines[0]).toEqual(
      expect.objectContaining({
        ingredientName: "chopped Onions",
        baseName: "chopped Onions",
        qualifier: null,
        noteText: null,
      })
    )
    expect(result.ingredients).toEqual([])
  })

  it.each([
    "almond sliced",
    "tomato diced",
    "coconut shredded",
    "pepper crushed",
    "sliced almond",
    "diced tomato",
    "shredded coconut",
    "crushed pepper",
  ])("does not infer a preparation from the bare phrase %s", (name) => {
    const [line] = parseRecipeText(`50 g ${name}`).parsedLines

    expect(line).toEqual(
      expect.objectContaining({
        ingredientName: name,
        baseName: name,
        qualifier: null,
        noteText: null,
      })
    )
  })

  it.each([
    ["almond, sliced", "almond", "sliced"],
    ["tomato (diced)", "tomato", "diced"],
  ])(
    "keeps an explicit preparation annotation in %s",
    (name, baseName, preparation) => {
      const [line] = parseRecipeText(`50 g ${name}`).parsedLines

      expect(line).toEqual(
        expect.objectContaining({
          ingredientName: name,
          baseName,
          qualifier: preparation,
          noteText: preparation,
        })
      )
    }
  )

  it("strips non-measure annotations without inventing a qualifier", () => {
    const result = parseRecipeText("1 cup All-purpose flour (divided)", {
      measures: [flourCup],
    })

    expect(result.parsedLines[0].qualifier).toBeNull()
    expect(result.ingredients[0].grams).toBe(125)
  })

  it.each([
    "All-purpose flour (sifted), divided",
    "All-purpose flour (sifted) (divided)",
    "All-purpose flour, sifted (divided)",
    "All-purpose flour, sifted (room temperature)",
  ])("preserves a qualifier through composed annotations in %s", (name) => {
    const siftedFlour: IngredientMeasure = {
      ...flourCup,
      id: "sifted-flour-composed",
      grams: 120,
      qualifier: "sifted",
    }
    const result = parseRecipeText(`1 cup ${name}`, {
      measures: [siftedFlour],
    })

    expect(result.parsedLines[0].qualifier).toBe("sifted")
    expect(result.ingredients[0].grams).toBe(120)
  })

  it("prefers a qualifier-specific measure and a direct matching unit", () => {
    const genericSugar: IngredientMeasure = {
      ...flourCup,
      id: "generic-sugar",
      name: "Brown sugar",
      normalizedName: "brown sugar",
      grams: 200,
    }
    const packedCup: IngredientMeasure = {
      ...genericSugar,
      id: "packed-cup",
      grams: 220,
      qualifier: "packed",
    }
    const packedTablespoon: IngredientMeasure = {
      ...packedCup,
      id: "packed-tablespoon",
      unit: "tbsp",
      grams: 13.5,
    }

    const result = parseRecipeText("1 tbsp Brown sugar (packed)", {
      measures: [genericSugar, packedCup, packedTablespoon],
    })

    expect(result.ingredients[0].grams).toBe(13.5)
  })

  it("propagates a disputed catalog range into recipe review state", () => {
    const rangedFlour: IngredientMeasure = {
      ...flourCup,
      lowGrams: 100,
      highGrams: 150,
    }
    const result = parseRecipeText("2 cups All-purpose flour", {
      measures: [rangedFlour],
    })

    expect(result.ingredients[0].grams).toBe(250)
    expect(result.parsedLines[0].measureRange).toEqual({
      lowGrams: 200,
      highGrams: 300,
      requiresReview: true,
    })
    expect(result.parsedLines[0].note).toContain("review this estimate")
  })

  it("does not apply an unqualified measure to a qualified ingredient", () => {
    const result = parseRecipeText("1 cup All-purpose flour (sifted)", {
      measures: [flourCup],
    })

    // Neither the unqualified saved cup nor the generic 125 g density knows
    // what sifting does, so the line stays unresolved and asks.
    expect(result.ingredients).toEqual([])
    expect(result.unresolvedLines[0]).toEqual(
      expect.objectContaining({
        ingredientName: "All-purpose flour (sifted)",
        qualifier: "sifted",
        resolutionSource: null,
      })
    )
  })

  it("keeps a packed volume unresolved rather than reading it as loose", () => {
    const result = parseRecipeText("1 cup Brown sugar, packed")

    expect(result.ingredients).toEqual([])
    expect(result.unresolvedLines[0]).toEqual(
      expect.objectContaining({
        ingredientName: "Brown sugar, packed",
        qualifier: "packed",
        resolutionSource: null,
      })
    )
  })

  it("uses explicit dual weights before catalog measures", () => {
    const result = parseRecipeText("1 cup (120 g) All-purpose flour", {
      measures: [flourCup],
    })

    expect(result.ingredients[0].grams).toBe(120)
    expect(result.parsedLines[0].ingredient?.name).toBe("All-purpose flour")
    expect(result.parsedLines[0].resolutionSource).toBe("explicit-weight")
  })

  it("multiplies a per-container explicit weight by its count", () => {
    const result = parseRecipeText("2 cans (14 oz) Tomatoes")

    expect(result.ingredients[0]).toEqual(
      expect.objectContaining({ name: "Tomatoes" })
    )
    expect(result.ingredients[0].grams).toBeCloseTo(793.7866475, 5)
    expect(result.parsedLines[0].resolutionSource).toBe("explicit-weight")
  })

  it.each([
    ["2 jars (16 oz) Tomatoes", "jar"],
    ["2 bottles (16 oz each) Tomato juice", "bottle"],
    ["2 (16 oz) bags Frozen peas", "bag"],
    ["2 boxes (16 oz) Pasta", "box"],
    ["2 cans (14-ounce) Diced tomatoes", "can"],
  ] as const)("parses explicit container weights in %s", (text, unit) => {
    const result = parseRecipeText(text)

    expect(result.parsedLines[0].normalizedUnit).toBe(unit)
    const expected = text.includes("14-ounce") ? 793.7866475 : 907.18474
    expect(result.ingredients[0].grams).toBeCloseTo(expected, 5)
  })

  it("parses unparenthesized package-size notation", () => {
    const result = parseRecipeText("2 14-ounce cans Diced tomatoes")

    expect(result.parsedLines[0]).toEqual(
      expect.objectContaining({
        normalizedUnit: "can",
        ingredientName: "Diced tomatoes",
        resolutionSource: "explicit-weight",
      })
    )
    expect(result.ingredients[0].grams).toBeCloseTo(793.7866475, 5)
  })

  it("treats an explicit weight after a volume as the total weight", () => {
    const result = parseRecipeText("2 cups (240 g) All-purpose flour")

    expect(result.ingredients[0].grams).toBe(240)
  })

  it("honors explicit each and total markers across measure classes", () => {
    const result = parseRecipeText(
      "2 cups (120 g each) All-purpose flour\n2 cups (240 g total) All-purpose flour"
    )

    expect(result.ingredients.map(({ grams }) => grams)).toEqual([240, 240])
  })

  it("supports vulgar fractions and attached mixed fractions", () => {
    const result = parseRecipeText(
      "½ cup All-purpose flour\n1½ cups All-purpose flour",
      { measures: [flourCup] }
    )
    expect(result.ingredients.map((ingredient) => ingredient.grams)).toEqual([
      62.5, 187.5,
    ])
  })

  it("reads an amount range at its low end and says so", () => {
    const result = parseRecipeText("1–2 cups All-purpose flour", {
      measures: [flourCup],
    })
    expect(result.skippedLines).toEqual([])
    const [line] = result.parsedLines
    expect(line.enteredAmount).toBe(1)
    expect(line.normalizedUnit).toBe("cup")
    expect(line.amountRange).toEqual({ low: 1, high: 2 })
    expect(line.noteText).toBe("(1–2 cups)")
    expect(line.ingredient?.grams).toBe(125)

    const methodRange = parseRecipeText("1–2 hours rest")
    expect(methodRange.parsedLines).toEqual([])
    expect(methodRange.skippedLines[0].affectsPricing).toBe(false)
  })

  it("separates prose from lines that were meant to be ingredients", () => {
    const result = parseRecipeText(
      "Blind-bake the tart shells.\n2 cups\n1–2 hours resting"
    )

    expect(
      result.skippedLines.map(({ lineNumber, kind }) => ({ lineNumber, kind }))
    ).toEqual([
      { lineNumber: 1, kind: "prose" },
      { lineNumber: 2, kind: "unconvertible" },
      { lineNumber: 3, kind: "prose" },
    ])
  })

  it("reads a numbered step as method text, not a one-gram ingredient", () => {
    const result = parseRecipeText("1. Mix the dough\n2) Rest 30 minutes")

    expect(result.parsedLines).toEqual([])
    expect(
      result.skippedLines.map(({ lineNumber, rawLine, kind }) => ({
        lineNumber,
        rawLine,
        kind,
      }))
    ).toEqual([
      { lineNumber: 1, rawLine: "1. Mix the dough", kind: "prose" },
      { lineNumber: 2, rawLine: "2) Rest 30 minutes", kind: "prose" },
    ])
  })

  it("costs an ingredients-only block", () => {
    // Parity with the Python parser test
    // "test_recipe_health_parser_costs_an_ingredients_only_block". With method
    // held in its own field, the authoritative ingredient block parses to
    // exactly these grams in both read models — the container-weight line
    // included.
    const result = parseRecipeText(
      "650 g Bread Flour\n2 400 g cans Diced tomatoes\n8 g Kosher Salt"
    )

    expect(result.skippedLines).toEqual([])
    expect(result.ingredients).toEqual([
      { id: "paste-1", name: "Bread Flour", grams: 650 },
      { id: "paste-2", name: "Diced tomatoes", grams: 800 },
      { id: "paste-3", name: "Kosher Salt", grams: 8 },
    ])
  })

  it("keeps decimal and single-unit amounts as ingredients", () => {
    const result = parseRecipeText(
      "1.5 kg Flour\n2 kg Flour\n1 egg\n500 g Bread Flour",
      { identities: pantry("egg") }
    )

    expect(result.skippedLines).toEqual([])
    expect(result.ingredients).toEqual([
      { id: "paste-1", name: "Flour", grams: 1500 },
      { id: "paste-2", name: "Flour", grams: 2000 },
      // A bare count of a profile that knows its each-weight is that count,
      // never that many grams.
      { id: "paste-3", name: "egg", grams: 50 },
      { id: "paste-4", name: "Bread Flour", grams: 500 },
    ])
  })

  it("counts every piece a profile knows the weight of", () => {
    const result = parseRecipeText(
      "2 garlic cloves\n2 tomatoes\n4 cherry tomatoes",
      { identities: pantry("garlic cloves", "tomatoes", "cherry tomatoes") }
    )

    expect(
      result.parsedLines.map((line) => [
        line.normalizedUnit,
        line.ingredient?.grams ?? null,
      ])
    ).toEqual([
      // A clove is a piece, and a small tomato is not a large one: reading
      // either as its own count of grams costs a recipe by a factor.
      ["each", 10],
      ["each", 246],
      ["each", 68],
    ])
  })

  it("warns about an ingredient-shaped line but not a section heading", () => {
    const result = parseRecipeText("Filling\nEggs\n0 g Salt")

    expect(
      result.skippedLines.map(({ lineNumber, kind }) => ({ lineNumber, kind }))
    ).toEqual([
      { lineNumber: 1, kind: "prose" },
      { lineNumber: 3, kind: "unconvertible" },
    ])
    expect(result.parsedLines.map((line) => line.rawLine)).toEqual(["Eggs"])
  })

  it("keeps a heading, a note and an unmeasured ingredient apart", () => {
    const result = parseRecipeText(
      "Dough:\n# Toppings\nNote: chill 1 hr\nKosher salt, to taste\n1 tsp Salt:"
    )

    expect(result.headerLines.map((line) => line.text)).toEqual([
      "Dough",
      "Toppings",
    ])
    expect(result.noteLines.map((line) => line.text)).toEqual(["chill 1 hr"])
    expect(result.skippedLines).toEqual([])
    expect(
      result.parsedLines.map(({ baseName, noteText, alert }) => ({
        baseName,
        noteText,
        alert,
      }))
    ).toEqual([
      { baseName: "Kosher salt", noteText: "to taste", alert: "unmeasured" },
      { baseName: "Salt", noteText: null, alert: null },
    ])
  })

  it("reads a trailing annotation with or without its comma", () => {
    // "salt to taste" is how most cooks type it; the comma is optional.
    const result = parseRecipeText(
      "salt to taste\nsalt, to taste\nolive oil for brushing"
    )

    expect(result.skippedLines).toEqual([])
    expect(
      result.parsedLines.map(
        ({ baseName, noteText, alert, enteredAmount }) => ({
          baseName,
          noteText,
          alert,
          enteredAmount,
        })
      )
    ).toEqual([
      {
        baseName: "salt",
        noteText: "to taste",
        alert: "unmeasured",
        enteredAmount: 0,
      },
      {
        baseName: "salt",
        noteText: "to taste",
        alert: "unmeasured",
        enteredAmount: 0,
      },
      {
        baseName: "olive oil",
        noteText: "for brushing",
        alert: "unmeasured",
        enteredAmount: 0,
      },
    ])
  })

  it("treats a time range as prose but reads an amount range", () => {
    const result = parseRecipeText(
      "20–25 minutes at 350F\n2–3 hours resting\n1–2 cups All-purpose flour"
    )

    expect(
      result.skippedLines.map(({ lineNumber, kind }) => ({ lineNumber, kind }))
    ).toEqual([
      { lineNumber: 1, kind: "prose" },
      { lineNumber: 2, kind: "prose" },
    ])
    expect(result.parsedLines.map((line) => line.amountRange)).toEqual([
      { low: 1, high: 2 },
    ])
  })

  it("does not assume an unmatched volume has water density", () => {
    const result = parseRecipeText("200 ml Mystery sauce")
    expect(result.ingredients).toEqual([])
    expect(result.unresolvedLines[0].ingredientName).toBe("Mystery sauce")
  })

  it("adds an explicit weight without discarding the entered measure", () => {
    const text = "1 cup Mystery sauce\nMix well."
    const line = parseRecipeText(text).unresolvedLines[0]
    expect(replaceRecipeLineWithExplicitWeight(text, line, 245)).toBe(
      "1 cup (245 g total) Mystery sauce\nMix well."
    )
  })

  it("keeps an editor-entered count weight as the total on reparse", () => {
    const text = "2 each Eggs"
    const line = parseRecipeText(text).parsedLines[0]
    const updated = replaceRecipeLineWithExplicitWeight(text, line, 100)

    expect(updated).toBe("2 each (100 g total) Eggs")
    expect(parseRecipeText(updated).ingredients[0].grams).toBe(100)
  })

  it("adds mass-conserving profiles for every ingredient in the sample", () => {
    for (const { name } of parseRecipeText(chefRecipe).ingredients) {
      const profile = findIngredientProfile(name)
      expect(profile, name).not.toBeNull()

      const solids = Object.values(profile?.solids ?? {}).reduce(
        (total, value) => total + value,
        0
      )
      expect((profile?.water ?? 0) + solids, name).toBeCloseTo(100, 8)
    }

    expect(findIngredientProfile("Butter")?.key).toBe("unsalted-butter")
  })

  it("names each profile identically in the shared parser vocabulary", () => {
    // `data/parser-vocabulary.json` is what the Python read model resolves
    // measures and each-weights through; nutrition resolves through
    // INGREDIENT_PROFILES. A drift between them would attribute a line to one
    // profile for weight and another for macros.
    expect(
      vocabulary.ingredientProfiles.map(({ key, name, aliases }) => ({
        key,
        name,
        aliases,
      }))
    ).toEqual(
      INGREDIENT_PROFILES.map(({ key, name, aliases }) => ({
        key,
        name,
        aliases,
      }))
    )
    expect(
      parseRecipeText("2 each Eggs", { identities: pantry("Eggs") })
        .parsedLines[0].note
    ).toBe("Converted using 50 g per Whole egg.")
  })
})

describe("matched shorthand", () => {
  it("weighs a matched shorthand from the name it was matched to", () => {
    const before = parseRecipeText("1 tbsp WWV")
    expect(before.parsedLines[0].ingredient).toBeNull()

    const after = parseRecipeText("1 tbsp WWV", {
      identities: [
        {
          id: "pantry-wwv",
          name: "White Wine Vinegar",
          normalizedName: "white wine vinegar",
          source: "pantry",
        },
      ],
      matches: [{ line: "wwv", targetId: "pantry-wwv" }],
    })
    // The chart knows vinegar, never the abbreviation.
    expect(after.parsedLines[0].resolutionSource).toBe("density")
    expect(after.parsedLines[0].ingredient?.grams).toBeCloseTo(14.9, 1)
  })

  it("weighs the ingredient it is priced as, not the word it was written as", () => {
    const result = parseRecipeText("1 cup flour", {
      identities: [
        {
          id: "pantry-oil",
          name: "Olive Oil",
          normalizedName: "olive oil",
          source: "pantry",
        },
      ],
      matches: [{ line: "flour", targetId: "pantry-oil" }],
    })

    // 125 g would weigh flour while costing oil.
    expect(result.parsedLines[0].resolutionSource).toBe("density")
    expect(result.parsedLines[0].ingredient?.grams).toBeCloseTo(216, 0)
  })
})

describe("density chart matching", () => {
  it("does not read a generic rule out of a compound name", () => {
    const result = parseRecipeText("1 cup Sugar Snap Peas")

    expect(result.ingredients).toEqual([])
    expect(result.unresolvedLines[0]).toEqual(
      expect.objectContaining({
        ingredientName: "Sugar Snap Peas",
        resolutionSource: null,
      })
    )
  })

  it("still weighs a plain generic name", () => {
    const result = parseRecipeText("1 cup Sugar\n1 cup All-purpose flour", {
      identities: pantry("Sugar", "All-purpose flour"),
    })

    expect(result.ingredients.map((line) => line.grams)).toEqual([200, 125])
  })

  it("uses the standard cup estimate only after an unknown name is matched", () => {
    const unmatched = parseRecipeText("1 cup Pimentón de la Vera")
    const matched = parseRecipeText("1 cup Pimentón de la Vera", {
      identities: pantry("Pimentón de la Vera"),
    })

    expect(unmatched.ingredients).toEqual([])
    expect(matched.ingredients[0].grams).toBeCloseTo(226.796185, 6)
    expect(matched.parsedLines[0].note).toContain(
      "standard 227 g per cup estimate"
    )
  })

  it("does not weigh a different product form as the rule's ingredient", () => {
    // The powder is a different physical product than the paste the rule
    // describes, steel-cut oats are not rolled, and riced cauliflower is not
    // dry rice; each would be costed from an invented weight.
    const result = parseRecipeText(
      "1 cup Peanut Butter Powder\n1 cup Steel Cut Oats\n1 cup Cauliflower Rice"
    )

    expect(result.ingredients).toEqual([])
    expect(result.unresolvedLines.map((line) => line.ingredientName)).toEqual([
      "Peanut Butter Powder",
      "Steel Cut Oats",
      "Cauliflower Rice",
    ])
  })

  it("still weighs descriptor-named products through their endings", () => {
    const result = parseRecipeText(
      "1 cup Cocoa Powder\n1 cup Granulated Sugar\n1 cup Semolina Flour\n1 cup Rolled Oats",
      {
        identities: pantry(
          "Cocoa Powder",
          "Granulated Sugar",
          "Semolina Flour",
          "Rolled Oats"
        ),
      }
    )

    expect(result.ingredients.map((line) => line.grams)).toEqual([
      85, 200, 167, 90,
    ])
  })

  it("keeps a component recipe off the chart when its title collides", () => {
    // A component named Honey is a prepared thing with its own weight, not
    // 340 g of raw honey. It stays unresolved until the line says what it
    // weighs.
    const result = parseRecipeText("1 cup Honey", {
      identities: [
        {
          id: "component-honey",
          name: "Honey",
          normalizedName: "honey",
          source: "component",
        },
      ],
    })

    expect(result.ingredients).toEqual([])
    expect(result.unresolvedLines[0]).toEqual(
      expect.objectContaining({
        ingredientName: "Honey",
        resolutionSource: null,
      })
    )
  })

  it("breaks a scoring tie between two measures on array order", () => {
    const heavierDuplicate: IngredientMeasure = {
      ...flourCup,
      id: "catalog-flour-cup-duplicate",
      grams: 200,
    }

    const result = parseRecipeText("1 cup All-purpose flour", {
      measures: [flourCup, heavierDuplicate],
    })

    expect(result.ingredients[0].grams).toBe(125)
  })
})

describe("shared line corpus", () => {
  // The same JSON drives apps/api/forkluck/test_recipe_parse_parity.py, so a
  // form fixed here cannot drift in the Django read model.
  it.each(corpus.lines)("reads $line", ({ line, expect: expected }) => {
    const result = parseRecipeText(line)

    if (expected.skipped) {
      expect(result.parsedLines).toEqual([])
      expect(result.skippedLines).toEqual([
        {
          lineNumber: 1,
          rawLine: line.trim(),
          reason: expect.any(String),
          affectsPricing: expected.affectsPricing,
          kind: expected.kind,
        },
      ])
      return
    }

    if (expected.kind === "header" || expected.kind === "note") {
      const section =
        expected.kind === "header" ? result.headerLines : result.noteLines
      expect(result.parsedLines).toEqual([])
      expect(section.map((entry) => entry.text)).toEqual([expected.text])
      return
    }

    expect(result.skippedLines).toEqual([])
    const parsed = result.parsedLines[0]
    expect(parsed.normalizedUnit).toBe(expected.unit)
    expect(parsed.ingredientName).toBe(expected.name)
    expect(parsed.alert).toBe(expected.unmeasured ? "unmeasured" : null)
    if (expected.baseName !== undefined) {
      expect(parsed.baseName).toBe(expected.baseName)
    }
    if (expected.noteText !== undefined) {
      expect(parsed.noteText).toBe(expected.noteText)
    }
    if (expected.range !== undefined) {
      expect(parsed.amountRange).toEqual(expected.range)
    }
    if (expected.equivalent !== undefined) {
      expect(parsed.equivalent).toEqual(expected.equivalent)
    }
    if (expected.amount !== undefined) {
      expect(parsed.enteredAmount).toBeCloseTo(expected.amount, 3)
    }
    if (expected.qualifier !== undefined) {
      expect(parsed.qualifier).toBe(expected.qualifier)
    }
    if (expected.grams === null || expected.grams === undefined) {
      expect(parsed.ingredient).toBeNull()
    } else {
      expect(parsed.ingredient?.grams).toBeCloseTo(expected.grams, 1)
    }
    if (expected.reviewFlag !== undefined) {
      expect(parsed.measureRange?.requiresReview ?? false).toBe(
        expected.reviewFlag
      )
    }
  })
})

describe("no input text is silently lost", () => {
  // Unit words are represented by the entered/normalized unit and the weight
  // they produced, so only the remaining words have to survive as text.
  const unitWords =
    /^(?:g|gr|gram|grams|kg|mg|oz|ozs|ounce|ounces|lb|lbs|pound|pounds|ml|l|cl|dl|tsp|teaspoon|teaspoons|tbsp|tablespoon|tablespoons|cup|cups|c|fl|pt|qt|gal|each|ea|x|can|cans|tin|tins|jar|jars|bottle|bottles|bag|bags|box|boxes|packet|packets|package|packages|pkg|pkgs|pk|pks|clove|cloves|stick|sticks|slice|slices|pinch|pinches|dash|dashes|bunch|bunches)$/i

  it.each([
    "153 grams 00 flour (1 cup plus 1 tablespoon)",
    "2 tablespoons (30ml) vegetable oil",
    "1 large yellow onion, coarsely chopped",
    "2 cups mango chunks, (2 large mangoes) (fresh or frozen)",
    "2 x 400 g cans Chopped Tomatoes",
    "1 (14 oz) can diced tomatoes",
    "2 T Sugar",
    "2 pkg Yeast",
    "3 eggs",
    "1 tsp salt, divided",
    "1/2 tsp salt, or to taste",
    "1 cup Milk (240 ml)",
    "2 tablespoons plus 1 teaspoon sugar",
    "1,5 kg Sugar",
    "20-25 min",
    "Filling",
  ])("keeps every word of %s", (line) => {
    const result = parseRecipeText(line)
    if (result.skippedLines.length) {
      expect(result.parsedLines).toEqual([])
      return
    }
    const parsed = result.parsedLines[0]
    const kept = [parsed.ingredientName, parsed.qualifier, parsed.note]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase()
    const lost = line
      .split(/[^A-Za-z]+/)
      .filter((word) => word && !unitWords.test(word))
      .filter((word) => !kept.includes(word.toLowerCase()))

    expect(lost).toEqual([])
  })
})

// Two recipes as a cook pastes them, headings, notes and all.
const cookieRecipe = `Dough:
- 226 g unsalted butter, cut into 1cm / 1/2" cubes
- 3 1/2 to 4 cups all-purpose flour
- 1 tsp kosher salt, halve for table salt, +50% for flakes
- 2 large eggs
Toppings (optional):
- 1 cup (170 g) chocolate chips
- flaky sea salt, for sprinkling
Note: chill the dough for an hour`

const pizzaRecipe = `# Base
2 cups mango chunks, (2 large mangoes) (fresh or frozen)
(1lb/454g) shredded mozzarella cheese
(30ml) extra-virgin olive oil, plus more for greasing
1 Tablespoon (13g) tomato paste
Kosher salt, to taste
1. Heat the oven to 250C`

describe("every pasted line lands somewhere", () => {
  it.each([
    ["a cookie recipe", cookieRecipe],
    ["a pizza recipe", pizzaRecipe],
  ])("accounts for every line of %s", (_name, text) => {
    const result = parseRecipeText(text, { identities: pantry("eggs") })
    const written = text.split("\n").filter((line) => line.trim()).length
    const seen = [
      ...result.headerLines,
      ...result.noteLines,
      ...result.parsedLines,
      ...result.skippedLines,
    ].map((line) => line.lineNumber)

    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(written)
  })

  it("names the ingredient and keeps its instructions as the note", () => {
    const rows = parseRecipeText(cookieRecipe).parsedLines.map(
      ({ baseName, noteText }) => `${baseName} | ${noteText ?? ""}`
    )

    expect(rows).toContain('unsalted butter | cut into 1cm / 1/2" cubes')
    expect(rows).toContain(
      "kosher salt | halve for table salt, +50% for flakes"
    )
    expect(rows.every((row) => !row.split(" | ")[0].includes("("))).toBe(true)
  })

  it("reads a size word as the unit of a countable ingredient", () => {
    const [egg] = parseRecipeText("1 large egg", {
      identities: pantry("egg"),
    }).parsedLines

    expect(egg.normalizedUnit).toBe("large")
    expect(egg.ingredientName).toBe("egg")
    expect(egg.ingredient?.grams).toBe(50)

    // Nothing countable is named, so the size stays part of the name.
    const [bowl] = parseRecipeText("1 large bowl").parsedLines
    expect(bowl.ingredientName).toBe("large bowl")
  })

  it("keeps a quantity to the six decimals the recipe stores", () => {
    const [water] = parseRecipeText("1 1/3 cups water").parsedLines

    expect(water.enteredAmount).toBe(1.333333)
    expect(clampRecipeQuantity(water.enteredAmount)).toBe("1.333333")
    expect(clampRecipeQuantity("2.50000")).toBe("2.5")
  })

  it("reads the second measure a line states as an equivalent", () => {
    const [mango, mozzarella, oil, paste] =
      parseRecipeText(pizzaRecipe).parsedLines

    expect(mango.baseName).toBe("mango chunks")
    expect(mozzarella.equivalent).toEqual({ amount: 454, unit: "g" })
    expect(oil.enteredAmount).toBe(30)
    expect(oil.normalizedUnit).toBe("ml")
    expect(paste.equivalent).toEqual({ amount: 13, unit: "g" })
  })
})

describe("tidyVolume", () => {
  it("moves exact multiples up a unit and leaves the rest alone", () => {
    expect(tidyVolume(6, "tsp")).toEqual({ amount: 2, unit: "tbsp" })
    expect(tidyVolume(48, "tsp")).toEqual({ amount: 1, unit: "cup" })
    expect(tidyVolume(32, "tbsp")).toEqual({ amount: 2, unit: "cup" })
    expect(tidyVolume(4.5, "tsp")).toEqual({ amount: 4.5, unit: "tsp" })
    expect(tidyVolume(2, "tsp")).toEqual({ amount: 2, unit: "tsp" })
    expect(tidyVolume(7, "cup")).toEqual({ amount: 7, unit: "cup" })
  })
})
