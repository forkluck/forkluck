import { describe, expect, it } from "vitest"

import { precisionFor } from "@/lib/precise-ingredients"
import {
  RECIPE_TOOL_LINE_LIMIT,
  recipeLinesForTools,
  shownMeasure,
  type MeasurableRecipeLine,
} from "@/lib/recipe/lines-for-tools"
import { formatMeasuredAmount } from "@/lib/recipe/scale"

const line = (
  overrides: Partial<MeasurableRecipeLine>
): MeasurableRecipeLine => ({
  kind: "ingredient",
  displayName: "Flour",
  quantity: 100,
  unit: "g",
  preparationNote: "",
  ...overrides,
})

describe("recipeLinesForTools", () => {
  it("prints each scaled quantity exactly as the sheet prints it", () => {
    const { lines } = recipeLinesForTools(
      [
        line({ displayName: "Bread flour", quantity: 300 }),
        line({ displayName: "Fine sea salt", quantity: 7 }),
      ],
      1.5
    )
    // A bulk ingredient reads as a whole number; a precise one reads to a
    // tenth. Both come from the formatter the page uses.
    expect(lines[0]!.quantity).toBe(
      formatMeasuredAmount(450, "g", precisionFor("Bread flour"))
    )
    expect(lines[0]!.quantity).toBe("450")
    expect(lines[1]!.quantity).toBe(
      formatMeasuredAmount(10.5, "g", precisionFor("Fine sea salt"))
    )
    expect(lines[1]!.quantity).toBe("10.5")
  })

  it("keeps a sub-recipe line's own measure and strips notes of a measure", () => {
    const { lines, lineCount, truncated } = recipeLinesForTools(
      [
        line({
          kind: "subrecipe",
          displayName: "Lotus paste",
          quantity: 2,
          unit: "kg",
          preparationNote: "chilled",
        }),
        line({
          kind: "header",
          displayName: "Filling",
          quantity: null,
          unit: "",
        }),
        line({
          kind: "note",
          displayName: "Rest overnight.",
          quantity: null,
          unit: "",
        }),
      ],
      2
    )
    expect(lines).toEqual([
      {
        kind: "recipe",
        name: "Lotus paste",
        quantity: "4",
        unit: "kg",
        note: "chilled",
      },
      {
        kind: "note",
        name: "Filling",
        quantity: null,
        unit: null,
        note: null,
      },
      {
        kind: "note",
        name: "Rest overnight.",
        quantity: null,
        unit: null,
        note: null,
      },
    ])
    expect(lineCount).toBe(3)
    expect(truncated).toBe(false)
  })

  it("scales an exact volume into the measure a cook would reach for", () => {
    expect(shownMeasure({ quantity: 2, unit: "tsp" }, 3)).toEqual({
      amount: 2,
      unit: "tbsp",
    })
    // At 1x nothing is recomputed: the line is the recipe as written.
    expect(shownMeasure({ quantity: 2, unit: "tsp" }, 1)).toEqual({
      amount: 2,
      unit: "tsp",
    })
  })

  it("cuts a long list and says how long it was", () => {
    const items = Array.from({ length: RECIPE_TOOL_LINE_LIMIT + 5 }, (_, at) =>
      line({ displayName: `Ingredient ${at}` })
    )
    const result = recipeLinesForTools(items, 1)
    expect(result.lines).toHaveLength(RECIPE_TOOL_LINE_LIMIT)
    expect(result.lineCount).toBe(RECIPE_TOOL_LINE_LIMIT + 5)
    expect(result.truncated).toBe(true)
    expect(
      recipeLinesForTools(items.slice(0, RECIPE_TOOL_LINE_LIMIT), 1).truncated
    ).toBe(false)
  })
})
