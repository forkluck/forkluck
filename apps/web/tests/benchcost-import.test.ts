import { describe, expect, it } from "vitest"

import {
  formatSeconds,
  formatSecondsPerUnit,
  formatTimerDigits,
  parseTimerDigits,
  timerDigits,
} from "../lib/benchcost/format"
import { parseCostRecipeImport } from "../lib/benchcost/import-schema"

const validImport = {
  name: "Chocolate Chip",
  ingredientCostPerBatch: 24.5,
  batchYield: 72,
  sellableYield: null,
  steps: [
    { name: "Scale & mix dough", kind: "active", covers: 72 },
    { name: "Bake", kind: "passive", covers: 24 },
  ],
}

describe("parseCostRecipeImport", () => {
  it("accepts the documented import shape", () => {
    const result = parseCostRecipeImport(JSON.stringify(validImport))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.recipe.name).toBe("Chocolate Chip")
      expect(result.recipe.steps).toHaveLength(2)
      expect(result.recipe.sellableYield).toBeNull()
    }
  })

  it("defaults sellableYield to null when omitted", () => {
    const { sellableYield, ...rest } = validImport
    void sellableYield
    const result = parseCostRecipeImport(JSON.stringify(rest))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.recipe.sellableYield).toBeNull()
    }
  })

  it("rejects invalid JSON", () => {
    const result = parseCostRecipeImport("{not json")
    expect(result.ok).toBe(false)
  })

  it("rejects empty step names", () => {
    const bad = {
      ...validImport,
      steps: [{ name: "   ", kind: "active", covers: 72 }],
    }
    expect(parseCostRecipeImport(JSON.stringify(bad)).ok).toBe(false)
  })

  it("rejects unknown step kinds", () => {
    const bad = {
      ...validImport,
      steps: [{ name: "Mix", kind: "waiting", covers: 72 }],
    }
    expect(parseCostRecipeImport(JSON.stringify(bad)).ok).toBe(false)
  })

  it("rejects covers below 1", () => {
    const bad = {
      ...validImport,
      steps: [{ name: "Mix", kind: "active", covers: 0 }],
    }
    expect(parseCostRecipeImport(JSON.stringify(bad)).ok).toBe(false)
  })

  it("rejects batchYield below 1", () => {
    const bad = { ...validImport, batchYield: 0 }
    expect(parseCostRecipeImport(JSON.stringify(bad)).ok).toBe(false)
  })

  it("rejects a recipe with no steps", () => {
    const bad = { ...validImport, steps: [] }
    expect(parseCostRecipeImport(JSON.stringify(bad)).ok).toBe(false)
  })
})

describe("time and money formatting", () => {
  it("normalizes raw timer input to digits, keeping leading zeros", () => {
    expect(timerDigits("10:22")).toBe("1022")
    expect(timerDigits("0430")).toBe("0430")
    expect(timerDigits("abc")).toBe("")
    expect(timerDigits("1234567")).toBe("12345")
  })

  it("displays and parses leading-zero entries like a timer", () => {
    expect(formatTimerDigits("0430")).toBe("04:30")
    expect(parseTimerDigits("0430")).toBe(270)
    expect(formatTimerDigits("045")).toBe("0:45")
    expect(parseTimerDigits("045")).toBe(45)
  })

  it("formats digits like a kitchen timer display", () => {
    expect(formatTimerDigits("45")).toBe("45")
    expect(formatTimerDigits("130")).toBe("1:30")
    expect(formatTimerDigits("1022")).toBe("10:22")
  })

  it("parses timer digits into total seconds", () => {
    expect(parseTimerDigits("45")).toBe(45)
    expect(parseTimerDigits("130")).toBe(90)
    expect(parseTimerDigits("1022")).toBe(622)
    expect(parseTimerDigits("75")).toBe(75)
    expect(parseTimerDigits("")).toBeNull()
    expect(parseTimerDigits("0")).toBeNull()
  })

  it("formats seconds as m:ss", () => {
    expect(formatSeconds(90)).toBe("1:30")
    expect(formatSeconds(600)).toBe("10:00")
    expect(formatSeconds(5)).toBe("0:05")
  })

  it("formats per-piece efficiency with useful precision", () => {
    expect(formatSecondsPerUnit(8.372)).toBe("8.4 sec/pc")
    expect(formatSecondsPerUnit(12.4)).toBe("12 sec/pc")
  })
})
