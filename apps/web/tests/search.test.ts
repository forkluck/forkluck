import { describe, expect, it } from "vitest"

import {
  SEARCH_RANK,
  matchesIngredientSearch,
  matchesTokens,
  rankedIngredientMatches,
  rankedMatches,
  rankedServerResults,
  searchRank,
  searchTokens,
} from "../lib/search"

const flour = { normalizedName: "bread flour" }

describe("matchesIngredientSearch", () => {
  const maldon = { normalizedName: "maldon sea salt" }

  it("matches a query whose words are separated in the name", () => {
    // A recipe line seeds the picker's search box, so this is the first thing
    // the dialog shows for a pantry that already holds the ingredient.
    expect(matchesIngredientSearch(maldon, "maldon salt")).toBe(true)
    expect(matchesIngredientSearch(flour, "flour bread")).toBe(true)
    expect(
      matchesIngredientSearch(
        { normalizedName: "extra virgin olive oil" },
        "olive oil"
      )
    ).toBe(true)
  })

  it("ignores word order and the punctuation normalization drops", () => {
    expect(matchesIngredientSearch(maldon, "salt maldon")).toBe(true)
    expect(matchesIngredientSearch(maldon, "  Maldon,  SALT ")).toBe(true)
  })

  it("still requires every word, so a wrong word rules the entry out", () => {
    expect(matchesIngredientSearch(maldon, "maldon pepper")).toBe(false)
    expect(matchesIngredientSearch(maldon, "smoked")).toBe(false)
  })

  it("keeps every match phrase search already found", () => {
    expect(matchesIngredientSearch(maldon, "maldon")).toBe(true)
    expect(matchesIngredientSearch(maldon, "sea salt")).toBe(true)
  })

  it("shows the whole list when the query holds no words", () => {
    expect(matchesIngredientSearch(maldon, "")).toBe(true)
    expect(matchesIngredientSearch(maldon, "   ")).toBe(true)
    expect(matchesIngredientSearch(maldon, " - ")).toBe(true)
  })
})

describe("searchTokens", () => {
  it("folds accents and punctuation the way the stored keys are folded", () => {
    expect(searchTokens("Crème  Fraîche!")).toEqual(["creme", "fraiche"])
    expect(searchTokens("extra-virgin")).toEqual(["extra", "virgin"])
  })

  it("reads a query with no words as no search at all", () => {
    expect(searchTokens("")).toEqual([])
    expect(searchTokens(" -- ")).toEqual([])
  })

  it("caps the token count, since each token is one more AND clause", () => {
    expect(searchTokens("a b c d e f g h i j k l m n").length).toBe(12)
  })
})

describe("matchesTokens", () => {
  it("lets each token land in a different field", () => {
    // The product picker's case: name matches one word, a SKU the other.
    expect(matchesTokens(["Sourdough loaf", "BRD-100"], ["loaf", "brd"])).toBe(
      true
    )
  })

  it("fails when no field holds one of the tokens", () => {
    expect(matchesTokens(["Sourdough loaf", "BRD-100"], ["loaf", "rye"])).toBe(
      false
    )
  })
})

describe("searchRank", () => {
  it("puts an exact name above a prefix, a word start, and a substring", () => {
    expect(searchRank(["Sugar"], ["sugar"])).toBe(SEARCH_RANK.exact)
    expect(searchRank(["Sugar, icing"], ["sugar"])).toBe(SEARCH_RANK.prefix)
    expect(searchRank(["Icing sugar"], ["sugar"])).toBe(SEARCH_RANK.wordStart)
    expect(searchRank(["Unsugared cocoa"], ["sugar"])).toBe(
      SEARCH_RANK.contains
    )
  })

  it("scores a row on its best field", () => {
    // Matching a SKU exactly beats a name that merely contains the query.
    expect(searchRank(["Sourdough loaf", "BRD-100"], ["brd", "100"])).toBe(
      SEARCH_RANK.exact
    )
  })

  it("falls back to the first token for a multi-word query", () => {
    // A row whose words happen to run in the typed order is a plain prefix.
    expect(searchRank(["Bread flour, strong"], ["bread", "flour"])).toBe(
      SEARCH_RANK.prefix
    )
    // These two hold both words but never adjacently, so the whole-query rungs
    // all miss. Starting with the word typed first is what breaks the tie.
    expect(searchRank(["Bread, strong flour"], ["bread", "flour"])).toBe(
      SEARCH_RANK.wordStart
    )
    expect(searchRank(["Strong flour, bread"], ["bread", "flour"])).toBe(
      SEARCH_RANK.contains
    )
  })
})

describe("rankedMatches", () => {
  const rows = [
    { name: "Almond flour" },
    { name: "Unbleached flour blend" },
    { name: "Flour" },
    { name: "Flour, bread" },
  ]

  it("ranks before it returns, so a slice keeps the best rows", () => {
    // Alphabetical order would have led with "Almond flour" and dropped the
    // exact match off the end of a two-row list.
    expect(
      rankedMatches(rows, (row) => [row.name], "flour")
        .slice(0, 2)
        .map((row) => row.name)
    ).toEqual(["Flour", "Flour, bread"])
  })

  it("keeps the incoming order within a rung", () => {
    // Ties belong to whoever sent the list — for the palette that is the
    // server's own ranking, which must not be reshuffled here.
    expect(
      rankedMatches(rows, (row) => [row.name], "flour").map((row) => row.name)
    ).toEqual([
      "Flour",
      "Flour, bread",
      "Almond flour",
      "Unbleached flour blend",
    ])
  })

  it("returns everything, in order, when nothing was typed", () => {
    expect(rankedMatches(rows, (row) => [row.name], "  ")).toEqual(rows)
  })
})

describe("rankedIngredientMatches", () => {
  it("puts the pantry row the merchant meant first", () => {
    const entries = [
      { normalizedName: "almond flour" },
      { normalizedName: "bread flour" },
      { normalizedName: "flour" },
    ]
    expect(rankedIngredientMatches(entries, "flour")[0]).toEqual({
      normalizedName: "flour",
    })
  })
})

describe("rankedServerResults", () => {
  const items = [
    { label: "Butter", aliases: [] },
    { label: "Sea salt", aliases: [] },
  ]

  it("keeps a row the server matched on a field the browser never sees", () => {
    // "Maldon" is a supplier title behind Sea salt; the palette payload
    // carries only the label and aliases, so re-filtering would drop it.
    const ranked = rankedServerResults(
      items,
      (item) => [item.label, ...item.aliases],
      "maldon"
    )
    expect(ranked).toHaveLength(2)
  })

  it("still puts a direct label match first", () => {
    const ranked = rankedServerResults(
      items,
      (item) => [item.label, ...item.aliases],
      "sea"
    )
    expect(ranked[0].label).toBe("Sea salt")
  })
})
