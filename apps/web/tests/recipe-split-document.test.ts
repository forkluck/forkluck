import { describe, expect, it } from "vitest"

import { splitRecipeDocument } from "@/lib/recipe/split-document"

const HEADED = `Lemon tart

# Pastry
250 g plain flour
125 g cold butter
1 egg yolk

# Filling
4 eggs
150 ml lemon juice
> use unwaxed lemons

Method:
Rub the butter into the flour until it looks like sand.
Line the tin and blind bake for 15 minutes.
Whisk the eggs with the juice.
Bake until the filling only just sets.`

const BARE = `250 g plain flour
125 g cold butter
4 eggs
150 ml lemon juice
Rub the butter into the flour until it looks like sand.
Line the tin and blind bake for 15 minutes.
Whisk the eggs with the juice.
Bake until the filling only just sets.`

describe("splitting a pasted recipe", () => {
  it("hands everything after a method heading to the method", () => {
    const split = splitRecipeDocument(HEADED)

    expect(split.method.split("\n")).toEqual([
      "Rub the butter into the flour until it looks like sand.",
      "Line the tin and blind bake for 15 minutes.",
      "Whisk the eggs with the juice.",
      "Bake until the filling only just sets.",
    ])
    // The list keeps its own headings and notes.
    expect(split.ingredients).toContain("# Pastry")
    expect(split.ingredients).toContain("> use unwaxed lemons")
    expect(split.ingredients).not.toContain("Method")
    expect(split.ingredients).not.toContain("Rub the butter")
  })

  it("reads the sentences a headless page ends on as the method", () => {
    const split = splitRecipeDocument(BARE)

    expect(split.ingredients.split("\n")).toEqual([
      "250 g plain flour",
      "125 g cold butter",
      "4 eggs",
      "150 ml lemon juice",
    ])
    expect(split.method.split("\n")).toHaveLength(4)
    expect(split.method.startsWith("Rub the butter")).toBe(true)
  })

  it("reads numbered steps as the method", () => {
    const split = splitRecipeDocument(
      "500 g flour\n10 g salt\n1. Whisk the eggs.\n2. Fold in the flour."
    )

    expect(split.ingredients).toBe("500 g flour\n10 g salt")
    expect(split.method).toBe("1. Whisk the eggs.\n2. Fold in the flour.")
  })

  it("switches back to the ingredients on an ingredients heading", () => {
    const split = splitRecipeDocument(
      "Ingredients\n500 g flour\nMethod\nMix it well.\nBake it.\n# Ingredients\n200 g sugar"
    )

    // Both headings are the seam itself, so neither is kept as a row.
    expect(split.ingredients).toBe("500 g flour\n200 g sugar")
    expect(split.method).toBe("Mix it well.\nBake it.")
  })

  it("keeps a sentence between two ingredients with the list", () => {
    const text = "500 g flour\nUse the good flour here.\n10 g salt"

    expect(splitRecipeDocument(text)).toEqual({
      ingredients: text,
      method: "",
    })
  })

  it("keeps a lone closing sentence with the list", () => {
    const text = "500 g flour\n10 g salt\nChill overnight."

    expect(splitRecipeDocument(text)).toEqual({
      ingredients: text,
      method: "",
    })
  })

  it("keeps a list that is only prose whole", () => {
    const text = "Some thoughts about a recipe.\nAnd another line of them."

    expect(splitRecipeDocument(text)).toEqual({
      ingredients: text,
      method: "",
    })
  })
})
