import { describe, expect, it } from "vitest"

import { parseRecipeText } from "@/lib/recipe"
import type { MeasurableRecipeLine } from "@/lib/recipe/lines-for-tools"
import {
  recipeMarkdown,
  type MarkdownRecipeLine,
  type MarkdownSubrecipe,
} from "@/lib/recipe/markdown"

const line = (overrides: Partial<MarkdownRecipeLine>): MarkdownRecipeLine => ({
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

/** A litre of sauce: 800 g tomatoes and 40 g oil go into each batch. */
const SAUCE: MarkdownSubrecipe = {
  title: "Tomato sauce",
  yieldAmount: 1000,
  yieldUnit: "g",
  items: [
    line({ displayName: "Tomatoes", quantity: 800 }),
    line({ displayName: "Olive oil", quantity: 40 }),
    note("Simmer until thick"),
  ],
}

const FOCACCIA: MarkdownRecipeLine[] = [
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
    quantity: 250,
    unit: "g",
    subrecipe: SAUCE,
  }),
  line({
    displayName: "Olive oil",
    quantity: null,
    unit: "",
    preparationNote: "for brushing",
  }),
  note("Rest overnight for the best flavour"),
]

describe("recipeMarkdown", () => {
  it("writes the title, its sections and each sub-recipe at the amount used", () => {
    expect(recipeMarkdown({ title: "Focaccia", items: FOCACCIA }, 1)).toBe(
      [
        "# Focaccia",
        "",
        "## Dough",
        "- 500 g Bread flour",
        "- 10.5 g Fine sea salt",
        "- 1 1/2 cup Water, lukewarm",
        "- 2 ea Egg",
        "",
        "## Topping",
        "- 250 g Tomato sauce",
        "- Olive oil, for brushing",
        "> Rest overnight for the best flavour",
        "",
        // A quarter of the sauce batch: what 250 g of a 1 kg yield takes.
        "## Tomato sauce",
        "- 200 g Tomatoes",
        "- 10 g Olive oil",
        "> Simmer until thick",
      ].join("\n")
    )
  })

  it("scales the amounts to the batch being viewed, as the sheet prints them", () => {
    const text = recipeMarkdown(
      {
        title: "",
        items: [
          line({ quantity: 300 }),
          line({ displayName: "Fine sea salt", quantity: 7 }),
          line({ displayName: "Water", quantity: 3, unit: "tbsp" }),
          line({
            kind: "subrecipe",
            displayName: "Tomato sauce",
            quantity: 500,
            unit: "g",
            subrecipe: SAUCE,
          }),
        ],
      },
      1.5
    )
    // Bulk flour to the gram, salt to the tenth, a volume tidied into the
    // unit a cook would measure it with, and the sub-recipe scaled with it:
    // 750 g of a 1 kg batch. No title means the lines start the document.
    expect(text.split("\n")).toEqual([
      "- 450 g Bread flour",
      "- 10.5 g Fine sea salt",
      "- 4 1/2 tbsp Water",
      "- 750 g Tomato sauce",
      "",
      "## Tomato sauce",
      "- 600 g Tomatoes",
      "- 30 g Olive oil",
      "> Simmer until thick",
    ])
  })

  it("adds up a sub-recipe called for twice, and nests its own sections", () => {
    const glaze: MarkdownSubrecipe = {
      title: "Glaze",
      yieldAmount: 100,
      yieldUnit: "g",
      items: [
        section("Base"),
        line({ displayName: "Sugar", quantity: 100 }),
        line({
          kind: "subrecipe",
          displayName: "Stock syrup",
          quantity: 20,
          unit: "g",
        }),
      ],
    }
    const use = (quantity: number) =>
      line({
        kind: "subrecipe",
        displayName: "Glaze",
        quantity,
        unit: "g",
        subrecipe: glaze,
      })
    expect(
      recipeMarkdown({ title: "Buns", items: [use(30), use(20)] }, 1)
    ).toBe(
      [
        "# Buns",
        "- 30 g Glaze",
        "- 20 g Glaze",
        "",
        "## Glaze",
        "",
        "### Base",
        "- 50 g Sugar",
        "- 10 g Stock syrup",
      ].join("\n")
    )
  })

  it("shows a sub-recipe as written when its amount cannot be converted", () => {
    const text = recipeMarkdown(
      {
        title: "Tart",
        items: [
          line({
            kind: "subrecipe",
            displayName: "Pastry",
            quantity: 1,
            unit: "each",
            subrecipe: {
              title: "Pastry",
              yieldAmount: null,
              yieldUnit: null,
              items: [line({ displayName: "Butter", quantity: 250 })],
            },
          }),
        ],
      },
      1
    )
    expect(text.split("\n").slice(-3)).toEqual([
      "## Pastry",
      "> Amounts for one full batch",
      "- 250 g Butter",
    ])
  })

  it("leaves out rows and sub-recipes that have no name", () => {
    expect(
      recipeMarkdown(
        {
          title: "  ",
          items: [
            line({ displayName: "  " }),
            section(""),
            line({}),
            line({
              kind: "subrecipe",
              displayName: "Sauce",
              quantity: 100,
              unit: "g",
              subrecipe: { ...SAUCE, title: "" },
            }),
          ],
        },
        1
      )
    ).toBe("- 500 g Bread flour\n- 100 g Sauce")
    expect(recipeMarkdown({ title: "", items: [] }, 1)).toBe("")
  })

  it("pastes back in through the importer as headers, lines and notes", () => {
    const parsed = parseRecipeText(
      recipeMarkdown({ title: "Focaccia", items: FOCACCIA }, 1)
    )
    // The title and the sub-recipe read as sections of their own.
    expect(parsed.headerLines.map((header) => header.text)).toEqual([
      "Focaccia",
      "Dough",
      "Topping",
      "Tomato sauce",
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
      [250, "g", "Tomato sauce", null],
      [0, null, "Olive oil", "for brushing"],
      [200, "g", "Tomatoes", null],
      [10, "g", "Olive oil", null],
    ])
    // The parser leaves a quoted line to the table, which reads "> …" as a
    // note row.
    expect(parsed.skippedLines.map((skipped) => skipped.rawLine)).toEqual([
      "> Rest overnight for the best flavour",
      "> Simmer until thick",
    ])
  })
})
