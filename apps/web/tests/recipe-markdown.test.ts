import { describe, expect, it } from "vitest"

import { parseRecipeText } from "@/lib/recipe"
import type { MeasurableRecipeLine } from "@/lib/recipe/lines-for-tools"
import { recipeLinesMarkdown } from "@/lib/recipe/markdown"

const line = (
  overrides: Partial<MeasurableRecipeLine>
): MeasurableRecipeLine => ({
  kind: "ingredient",
  displayName: "Bread flour",
  quantity: 500,
  unit: "g",
  preparationNote: "",
  ...overrides,
})

const section = (name: string): MeasurableRecipeLine =>
  line({ kind: "header", displayName: name, quantity: null, unit: "" })
const note = (text: string): MeasurableRecipeLine =>
  line({ kind: "note", displayName: text, quantity: null, unit: "" })

const FOCACCIA: MeasurableRecipeLine[] = [
  section("Dough"),
  line({}),
  line({ displayName: "Fine sea salt", quantity: 10.5 }),
  line({
    displayName: "Water",
    quantity: 1.5,
    unit: "cup",
    preparationNote: "lukewarm",
  }),
  line({ displayName: "Egg", quantity: 2, unit: "each" }),
  section("Topping"),
  line({
    kind: "subrecipe",
    displayName: "Tomato sauce",
    quantity: 0.25,
    unit: "cup",
  }),
  line({
    displayName: "Olive oil",
    quantity: null,
    unit: "",
    preparationNote: "for brushing",
  }),
  note("Rest overnight for the best flavour"),
]

describe("recipeLinesMarkdown", () => {
  it("writes sections, notes and measured lines the way a pasted recipe does", () => {
    expect(recipeLinesMarkdown(FOCACCIA, 1)).toBe(
      [
        "# Dough",
        "- 500 g Bread flour",
        "- 10.5 g Fine sea salt",
        "- 1 1/2 cup Water, lukewarm",
        "- 2 ea Egg",
        "# Topping",
        "- 1/4 cup Tomato sauce",
        "- Olive oil, for brushing",
        "> Rest overnight for the best flavour",
      ].join("\n")
    )
  })

  it("scales the amounts to the batch being viewed, as the sheet prints them", () => {
    const text = recipeLinesMarkdown(
      [
        line({ quantity: 300 }),
        line({ displayName: "Fine sea salt", quantity: 7 }),
        line({ displayName: "Water", quantity: 3, unit: "tbsp" }),
      ],
      1.5
    )
    // Bulk flour to the gram, salt to the tenth, and a volume tidied into the
    // unit a cook would measure it with.
    expect(text.split("\n")).toEqual([
      "- 450 g Bread flour",
      "- 10.5 g Fine sea salt",
      "- 4 1/2 tbsp Water",
    ])
  })

  it("leaves out rows that have no name", () => {
    expect(
      recipeLinesMarkdown(
        [line({ displayName: "  " }), section(""), line({})],
        1
      )
    ).toBe("- 500 g Bread flour")
    expect(recipeLinesMarkdown([], 1)).toBe("")
  })

  it("pastes back in as the rows it came from", () => {
    const parsed = parseRecipeText(recipeLinesMarkdown(FOCACCIA, 1))
    expect(parsed.headerLines.map((header) => header.text)).toEqual([
      "Dough",
      "Topping",
    ])
    expect(
      parsed.parsedLines.map((parsedLine) => [
        parsedLine.enteredAmount,
        parsedLine.normalizedUnit,
        parsedLine.baseName,
        parsedLine.noteText,
      ])
    ).toEqual([
      [500, "g", "Bread flour", null],
      [10.5, "g", "Fine sea salt", null],
      [1.5, "cup", "Water", "lukewarm"],
      [2, "each", "Egg", null],
      [0.25, "cup", "Tomato sauce", null],
      [0, null, "Olive oil", "for brushing"],
    ])
    // The parser leaves a quoted line to the table, which reads "> …" as a
    // note row.
    expect(parsed.skippedLines.map((skipped) => skipped.rawLine)).toEqual([
      "> Rest overnight for the best flavour",
    ])
  })
})
