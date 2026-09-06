import { describe, expect, it } from "vitest"

import { NUTRIENT_KEYS } from "@/lib/backend/schemas"
import type { Nutrients } from "@/lib/backend/types"
import {
  containsLine,
  declaredAllergens,
  formatServings,
  formatEuRows,
  formatUsRows,
  missingNutrients,
  nutrientsFromComposition,
  percentDailyValue,
  roundCalories,
  roundCarbGrams,
  roundCholesterol,
  roundEuGrams,
  roundEuSalt,
  roundFatGrams,
  roundIron,
  roundMineral10,
  roundSodium,
  roundVitaminD,
  scaleNutrients,
  statementRuns,
} from "@/lib/nutrition/label"

/** Every key complete at the given amounts; the rest complete at zero. */
function nutrients(
  amounts: Partial<Record<keyof Nutrients, number>>,
  incomplete: (keyof Nutrients)[] = []
): Nutrients {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((key) => [
      key,
      { amount: amounts[key] ?? 0, complete: !incomplete.includes(key) },
    ])
  ) as Nutrients
}

describe("US rounding ladders", () => {
  it("rounds calories at 5, 50 and beyond", () => {
    expect(roundCalories(4.9)).toBe(0)
    expect(roundCalories(5)).toBe(5)
    expect(roundCalories(12.4)).toBe(10)
    expect(roundCalories(12.5)).toBe(15)
    expect(roundCalories(50)).toBe(50)
    expect(roundCalories(51)).toBe(50)
    expect(roundCalories(55)).toBe(60)
    expect(roundCalories(254)).toBe(250)
  })

  it("rounds fat grams at 0.5 and 5", () => {
    expect(roundFatGrams(0.49)).toBe("0")
    expect(roundFatGrams(0.5)).toBe("0.5")
    expect(roundFatGrams(2.74)).toBe("2.5")
    expect(roundFatGrams(2.75)).toBe("3")
    expect(roundFatGrams(4.99)).toBe("5")
    expect(roundFatGrams(5)).toBe("5")
    expect(roundFatGrams(12.6)).toBe("13")
  })

  it("says less than 5 for a trace of cholesterol", () => {
    expect(roundCholesterol(1.9)).toBe("0")
    expect(roundCholesterol(2)).toBe("less than 5")
    expect(roundCholesterol(5)).toBe("less than 5")
    expect(roundCholesterol(5.1)).toBe("5")
    expect(roundCholesterol(12)).toBe("10")
    expect(roundCholesterol(13)).toBe("15")
  })

  it("rounds sodium at 5, 140 and beyond", () => {
    expect(roundSodium(4.9)).toBe("0")
    expect(roundSodium(5)).toBe("5")
    expect(roundSodium(138)).toBe("140")
    expect(roundSodium(140)).toBe("140")
    expect(roundSodium(141)).toBe("140")
    expect(roundSodium(146)).toBe("150")
  })

  it("says less than 1 for a trace of carbohydrate", () => {
    expect(roundCarbGrams(0.49)).toBe("0")
    expect(roundCarbGrams(0.5)).toBe("less than 1")
    expect(roundCarbGrams(0.99)).toBe("less than 1")
    expect(roundCarbGrams(1)).toBe("1")
    expect(roundCarbGrams(12.5)).toBe("13")
  })

  it("rounds vitamins and minerals on their own steps", () => {
    expect(roundVitaminD(2.04)).toBe("2")
    expect(roundVitaminD(2.06)).toBe("2.1")
    expect(roundIron(0.96)).toBe("1")
    expect(roundIron(1.25)).toBe("1.3")
    expect(roundMineral10(264)).toBe("260")
    expect(roundMineral10(265)).toBe("270")
  })
})

describe("percent daily value", () => {
  it("rounds macros to the whole percent from the unrounded amount", () => {
    expect(percentDailyValue(8.4, 78, "macro")).toBe(11)
    expect(percentDailyValue(0.3, 78, "macro")).toBe(0)
  })

  it("steps micros by 2, 5 and 10", () => {
    expect(percentDailyValue(1, 20, "micro")).toBe(6)
    expect(percentDailyValue(2, 20, "micro")).toBe(10)
    expect(percentDailyValue(2.2, 20, "micro")).toBe(10)
    expect(percentDailyValue(4.6, 20, "micro")).toBe(25)
    expect(percentDailyValue(10, 20, "micro")).toBe(50)
    expect(percentDailyValue(10.4, 20, "micro")).toBe(50)
    expect(percentDailyValue(13, 20, "micro")).toBe(70)
  })
})

describe("formatUsRows", () => {
  const perServing = nutrients({
    calories: 254,
    fat: 8.4,
    saturatedFat: 2.74,
    transFat: 0.2,
    cholesterolMg: 3,
    sodiumMg: 146,
    totalCarbohydrate: 37.4,
    fiber: 0.7,
    sugars: 12.5,
    addedSugars: 10,
    protein: 5.2,
    vitaminDMcg: 2.06,
    calciumMg: 264,
    ironMg: 1.25,
    potassiumMg: 235,
  })

  it("keeps the FDA order with the added sugars line indented twice", () => {
    const facts = formatUsRows(perServing)
    expect(facts.calories).toEqual({ amount: "250", atLeast: false })
    expect(facts.rows.map((row) => [row.key, row.indent])).toEqual([
      ["fat", 0],
      ["saturatedFat", 1],
      ["transFat", 1],
      ["cholesterolMg", 0],
      ["sodiumMg", 0],
      ["totalCarbohydrate", 0],
      ["fiber", 1],
      ["sugars", 1],
      ["addedSugars", 2],
      ["protein", 0],
    ])
    expect(facts.vitamins.map((row) => row.key)).toEqual([
      "vitaminDMcg",
      "calciumMg",
      "ironMg",
      "potassiumMg",
    ])
  })

  it("formats each row on its own ladder with its percent", () => {
    const facts = formatUsRows(perServing)
    const row = (key: string) =>
      [...facts.rows, ...facts.vitamins].find((entry) => entry.key === key)!
    expect(row("fat")).toMatchObject({ amount: "8", unit: "g", percent: 11 })
    expect(row("saturatedFat")).toMatchObject({ amount: "2.5", percent: 14 })
    expect(row("cholesterolMg")).toMatchObject({
      amount: "less than 5",
      unit: "mg",
      percent: 1,
    })
    expect(row("sodiumMg")).toMatchObject({ amount: "150", percent: 6 })
    expect(row("fiber")).toMatchObject({ amount: "less than 1", percent: 3 })
    expect(row("addedSugars")).toMatchObject({ amount: "10", percent: 20 })
    expect(row("vitaminDMcg")).toMatchObject({
      amount: "2.1",
      unit: "mcg",
      percent: 10,
    })
    expect(row("calciumMg")).toMatchObject({ amount: "260", percent: 20 })
    expect(row("ironMg")).toMatchObject({ amount: "1.3", percent: 6 })
    expect(row("potassiumMg")).toMatchObject({ amount: "240", percent: 6 })
  })

  it("gives trans fat, total sugars and protein no percent", () => {
    const facts = formatUsRows(perServing)
    for (const key of ["transFat", "sugars", "protein"]) {
      expect(facts.rows.find((row) => row.key === key)!.percent).toBeNull()
    }
  })

  it("marks an incomplete value at least, and the calories too", () => {
    const facts = formatUsRows(
      nutrients({ calories: 100, fat: 3 }, ["fat", "calories"])
    )
    expect(facts.calories).toEqual({ amount: "100", atLeast: true })
    expect(facts.rows.find((row) => row.key === "fat")!.atLeast).toBe(true)
    expect(facts.rows.find((row) => row.key === "protein")!.atLeast).toBe(false)
  })
})

describe("EU rounding", () => {
  it("rounds grams at 10 and 0.5", () => {
    expect(roundEuGrams(12.46)).toBe("12")
    expect(roundEuGrams(10)).toBe("10")
    expect(roundEuGrams(9.96)).toBe("10")
    expect(roundEuGrams(2.34)).toBe("2.3")
    expect(roundEuGrams(0.5)).toBe("0.5")
    expect(roundEuGrams(0.49)).toBe("<0.5")
  })

  it("rounds salt at 1 and 0.0125", () => {
    expect(roundEuSalt(1.26)).toBe("1.3")
    expect(roundEuSalt(1)).toBe("1")
    expect(roundEuSalt(0.456)).toBe("0.46")
    expect(roundEuSalt(0.0125)).toBe("0.01")
    expect(roundEuSalt(0.012)).toBe("<0.01")
  })

  it("builds the energy cell from the payload's kilojoules", () => {
    const per100g = nutrients({
      energyKj: 1046.2,
      calories: 250.3,
      fat: 8.4,
      saturatedFat: 2.34,
      totalCarbohydrate: 37.4,
      sugars: 12.46,
      protein: 5.24,
      salt: 0.456,
    })
    const perServing = scaleNutrients(per100g, 0.5)
    const rows = formatEuRows(per100g, perServing)
    expect(rows.map((row) => [row.label, row.per100g, row.perServing])).toEqual(
      [
        ["Energy", "1046 kJ / 250 kcal", "523 kJ / 125 kcal"],
        ["Fat", "8.4 g", "4.2 g"],
        ["of which saturates", "2.3 g", "1.2 g"],
        ["Carbohydrate", "37 g", "19 g"],
        ["of which sugars", "12 g", "6.2 g"],
        ["Protein", "5.2 g", "2.6 g"],
        ["Salt", "0.46 g", "0.23 g"],
      ]
    )
    expect(rows.map((row) => row.indent)).toEqual([
      false,
      false,
      true,
      false,
      true,
      false,
      false,
    ])
  })

  it("leaves the serving column out and flags incomplete rows", () => {
    const rows = formatEuRows(
      nutrients({ calories: 100, energyKj: 418 }, ["saturatedFat"]),
      null
    )
    expect(rows.every((row) => row.perServing === null)).toBe(true)
    expect(rows.find((row) => row.key === "saturatedFat")!.atLeast).toBe(true)
    expect(rows.find((row) => row.key === "fat")!.atLeast).toBe(false)
  })
})

describe("formatServings", () => {
  it("rounds the count the way the panel must print it", () => {
    expect(formatServings(12)).toBe("12")
    expect(formatServings(3.33)).toBe("about 3.5")
    expect(formatServings(2.5)).toBe("2.5")
    expect(formatServings(7.6)).toBe("about 8")
    expect(formatServings(1.4)).toBe("about 1")
  })
})

describe("declaredAllergens", () => {
  const keys = ["allium", "milk", "sulphites", "celery", "nightshades", "egg"]

  it("declares the US nine and keeps the rest as kitchen tags", () => {
    expect(declaredAllergens(keys, "us")).toEqual({
      declared: ["Milk", "Egg"],
      kitchen: ["Sulphites", "Celery", "Allium", "Nightshades"],
    })
  })

  it("drops a left-off tag that a declared one already covers", () => {
    expect(declaredAllergens(["wheat", "gluten_cereals"], "us")).toEqual({
      declared: ["Wheat"],
      kitchen: [],
    })
    expect(declaredAllergens(["gluten_cereals"], "us")).toEqual({
      declared: [],
      kitchen: ["Cereals containing gluten"],
    })
  })

  it("declares the EU fourteen, wheat among them as a gluten cereal", () => {
    expect(declaredAllergens(keys, "eu")).toEqual({
      declared: ["Milk", "Egg", "Sulphites", "Celery"],
      kitchen: ["Allium", "Nightshades"],
    })
    expect(declaredAllergens(["wheat"], "eu").declared).toEqual(["Wheat"])
  })
})

describe("statementRuns", () => {
  const entries = [
    { name: "Flour", grams: 200, allergens: ["wheat"] },
    { name: "Sugar", grams: 100, allergens: [] },
    { name: "Onion", grams: 50, allergens: ["allium"] },
    { name: "Celery", grams: 20, allergens: ["celery"] },
  ]

  it("emphasises the entries carrying a US declared tag", () => {
    expect(statementRuns(entries, "us")).toEqual([
      { name: "Flour", emphasised: true },
      { name: "Sugar", emphasised: false },
      { name: "Onion", emphasised: false },
      { name: "Celery", emphasised: false },
    ])
  })

  it("emphasises celery too on an EU label", () => {
    expect(statementRuns(entries, "eu").map((run) => run.emphasised)).toEqual([
      true,
      false,
      false,
      true,
    ])
  })
})

describe("containsLine", () => {
  const entries = [
    { name: "Almonds", grams: 50, allergens: ["tree_nuts"] },
    { name: "Walnuts", grams: 20, allergens: ["tree_nuts"] },
    { name: "Milk", grams: 100, allergens: ["milk"] },
  ]

  it("names the species the statement carries", () => {
    expect(containsLine(entries, ["milk", "tree_nuts"], "us")).toEqual({
      groups: ["Milk", "Tree nuts (Almonds, Walnuts)"],
      unnamedSpecies: false,
    })
  })

  it("keeps a species group alone when no entry names the kind", () => {
    expect(containsLine(entries, ["fish"], "us")).toEqual({
      groups: ["Fish"],
      unnamedSpecies: true,
    })
  })

  it("drops kitchen-only tags from the line", () => {
    expect(containsLine(entries, ["milk", "allium"], "us").groups).toEqual([
      "Milk",
    ])
  })

  it("returns no contains line on an EU label", () => {
    expect(containsLine(entries, ["milk", "tree_nuts"], "eu").groups).toEqual(
      []
    )
  })
})

describe("nutrientsFromComposition", () => {
  const per100g = {
    water: 16,
    fat: 81,
    protein: 0.9,
    sugars: 0.1,
    starch: 0,
    fiber: 0,
    salt: 1.6,
    other: 0.4,
    totalCarbohydrate: 0.1,
    sodiumMg: 640,
    saturatedFat: 51,
    calories: 717,
    transFat: null,
    cholesterolMg: 215,
    addedSugars: null,
    vitaminDMcg: null,
    calciumMg: 24,
    ironMg: 0.02,
    potassiumMg: 24,
  }

  it("marks a key the record does not report incomplete, never zero", () => {
    const values = nutrientsFromComposition(per100g)
    expect(values.calories).toEqual({ amount: 717, complete: true })
    expect(values.energyKj.amount).toBeCloseTo(717 * 4.184)
    expect(values.transFat).toEqual({ amount: 0, complete: false })
    expect(values.vitaminDMcg).toEqual({ amount: 0, complete: false })
    expect(values.addedSugars).toEqual({ amount: 0, complete: false })
    expect(values.calciumMg).toEqual({ amount: 24, complete: true })
    expect(missingNutrients(values, "us")).toEqual([
      "transFat",
      "addedSugars",
      "vitaminDMcg",
    ])
    expect(missingNutrients(values, "eu")).toEqual([])
  })

  it("derives energy from the macros when the record states none", () => {
    const values = nutrientsFromComposition({ ...per100g, calories: null })
    // 4 kcal/g protein, 4 kcal/g available carbohydrate, 9 kcal/g fat.
    expect(values.calories.amount).toBeCloseTo(0.9 * 4 + 0.1 * 4 + 81 * 9)
    expect(values.calories.complete).toBe(true)
  })

  it("counts sugars as added sugars on a flagged ingredient", () => {
    const values = nutrientsFromComposition(
      { ...per100g, sugars: 99.8 },
      { sugarsAreAdded: true }
    )
    expect(values.addedSugars).toEqual({ amount: 99.8, complete: true })
  })

  it("falls back to the contract's carbohydrate and sodium derivations", () => {
    const values = nutrientsFromComposition({
      ...per100g,
      totalCarbohydrate: undefined,
      sodiumMg: undefined,
      sugars: 2,
      starch: 3,
      fiber: 1,
      salt: 2.5,
    })
    expect(values.totalCarbohydrate).toEqual({ amount: 6, complete: true })
    expect(values.sodiumMg).toEqual({ amount: 1000, complete: true })
  })
})

describe("scaleNutrients", () => {
  it("scales every amount and keeps completeness", () => {
    const scaled = scaleNutrients(
      nutrients({ fat: 10, protein: 4 }, ["fat"]),
      0.25
    )
    expect(scaled.fat).toEqual({ amount: 2.5, complete: false })
    expect(scaled.protein).toEqual({ amount: 1, complete: true })
  })
})
