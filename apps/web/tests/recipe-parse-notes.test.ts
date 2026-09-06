import { describe, expect, it } from "vitest"

import { parseRecipeText, type ParsedRecipeLine } from "../lib/recipe"

/**
 * A published lemon tart, pasted as its author wrote it. Every aside the cook
 * put on a line stays readable as a note, and none of it welds itself to the
 * name the kitchen stocks the ingredient under.
 */
type Expected = {
  line: string
  quantity: number
  unit: string | null
  name: string
  noteText: string | null
  qualifier: string | null
  sizeWord: string | null
  identityCandidates: string[]
}

const LEMON_TART: Expected[] = [
  {
    line: "1/3 cup lemon zest (1 ounce; 28 g) from 6 medium lemons",
    quantity: 0.333333,
    unit: "cup",
    name: "lemon zest",
    noteText: "1 ounce; 28 g, from 6 medium lemons",
    qualifier: null,
    sizeWord: null,
    identityCandidates: ["lemon zest"],
  },
  {
    line: "1 cup (240 ml) lemon juice from 6 medium lemons",
    quantity: 1,
    unit: "cup",
    name: "lemon juice",
    noteText: "240 ml, from 6 medium lemons",
    qualifier: null,
    sizeWord: null,
    identityCandidates: ["lemon juice"],
  },
  {
    line: "1/4 teaspoon Diamond Crystal kosher salt; for table salt, use half as much by volume",
    quantity: 0.25,
    unit: "tsp",
    name: "Diamond Crystal kosher salt",
    noteText: "for table salt, use half as much by volume",
    qualifier: null,
    sizeWord: null,
    identityCandidates: ["diamond crystal kosher salt"],
  },
  {
    line: "3/4 cup granulated sugar (5 1/4 ounces; 150 g)",
    quantity: 0.75,
    unit: "cup",
    name: "granulated sugar",
    noteText: "5 1/4 ounces; 150 g",
    qualifier: null,
    sizeWord: null,
    identityCandidates: ["granulated sugar"],
  },
  {
    line: "5 tablespoons unsalted butter (2 1/2 ounces; 70 g), softened",
    quantity: 5,
    unit: "tbsp",
    name: "unsalted butter",
    noteText: "2 1/2 ounces; 70 g, softened",
    qualifier: "softened",
    sizeWord: null,
    identityCandidates: ["unsalted butter"],
  },
  {
    line: "3 large eggs",
    quantity: 3,
    unit: null,
    name: "large eggs",
    noteText: null,
    qualifier: null,
    sizeWord: "large",
    identityCandidates: ["eggs"],
  },
  {
    line: "3 large egg yolks",
    quantity: 3,
    unit: null,
    name: "large egg yolks",
    noteText: null,
    qualifier: null,
    sizeWord: "large",
    identityCandidates: ["egg yolks"],
  },
  {
    line: "1 each Tart Crust, baked and cooled",
    quantity: 1,
    unit: "each",
    name: "Tart Crust",
    noteText: "baked and cooled",
    qualifier: null,
    sizeWord: null,
    identityCandidates: ["tart crust"],
  },
  {
    line: "2 3/4 cups Lemon Curd",
    quantity: 2.75,
    unit: "cup",
    name: "Lemon Curd",
    noteText: null,
    qualifier: null,
    sizeWord: null,
    identityCandidates: ["lemon curd"],
  },
  {
    line: "1 1/4 cups all-purpose flour (5 1/2 ounces; 160 g)",
    quantity: 1.25,
    unit: "cup",
    name: "all-purpose flour",
    noteText: "5 1/2 ounces; 160 g",
    qualifier: null,
    sizeWord: null,
    identityCandidates: ["all purpose flour"],
  },
  {
    line: "1/3 cup granulated sugar (2 1/3 ounces; 65 g)",
    quantity: 0.333333,
    unit: "cup",
    name: "granulated sugar",
    noteText: "2 1/3 ounces; 65 g",
    qualifier: null,
    sizeWord: null,
    identityCandidates: ["granulated sugar"],
  },
  {
    line: "1/4 teaspoon Diamond Crystal kosher salt",
    quantity: 0.25,
    unit: "tsp",
    name: "Diamond Crystal kosher salt",
    noteText: null,
    qualifier: null,
    sizeWord: null,
    identityCandidates: ["diamond crystal kosher salt"],
  },
  {
    line: "8 tablespoons unsalted butter (4 ounces; 113 g), melted",
    quantity: 8,
    unit: "tbsp",
    name: "unsalted butter",
    noteText: "4 ounces; 113 g, melted",
    qualifier: "melted",
    sizeWord: null,
    identityCandidates: ["unsalted butter"],
  },
  {
    line: "1/2 teaspoon vanilla extract",
    quantity: 0.5,
    unit: "tsp",
    name: "vanilla extract",
    noteText: null,
    qualifier: null,
    sizeWord: null,
    identityCandidates: ["vanilla extract"],
  },
]

function parsedLine(line: string): ParsedRecipeLine {
  const parsed = parseRecipeText(line)
  expect(parsed.skippedLines).toEqual([])
  expect(parsed.parsedLines).toHaveLength(1)
  return parsed.parsedLines[0]
}

describe("a line keeps the cook's words as a note", () => {
  it.each(LEMON_TART)("reads $line", (expected) => {
    const parsed = parsedLine(expected.line)
    expect({
      quantity: parsed.enteredAmount,
      unit: parsed.normalizedUnit,
      name: parsed.baseName,
      noteText: parsed.noteText,
      qualifier: parsed.qualifier,
      sizeWord: parsed.sizeWord,
      identityCandidates: parsed.identityCandidates,
    }).toEqual({
      quantity: expected.quantity,
      unit: expected.unit,
      name: expected.name,
      noteText: expected.noteText,
      qualifier: expected.qualifier,
      sizeWord: expected.sizeWord,
      identityCandidates: expected.identityCandidates,
    })
  })

  it("keeps the restated measure readable as the line's other measure", () => {
    expect(
      parsedLine("1 cup (240 ml) lemon juice from 6 medium lemons").equivalent
    ).toEqual({ amount: 240, unit: "ml" })
  })

  it("reads the whole tart in one paste", () => {
    const parsed = parseRecipeText(
      LEMON_TART.map((expected) => expected.line).join("\n")
    )
    expect(parsed.skippedLines).toEqual([])
    expect(parsed.parsedLines.map((line) => line.baseName)).toEqual(
      LEMON_TART.map((expected) => expected.name)
    )
    expect(parsed.parsedLines.map((line) => line.noteText)).toEqual(
      LEMON_TART.map((expected) => expected.noteText)
    )
  })
})

describe("identity follows the peeled name", () => {
  it("keeps a peeled note out without shortening the ingredient", () => {
    const [salt] = parseRecipeText(
      "1 tsp kosher salt, halve for table salt, +50% for flakes"
    ).parsedLines
    expect(salt.baseName).toBe("kosher salt")
    expect(salt.identityCandidates).toEqual(["kosher salt"])
  })
})
