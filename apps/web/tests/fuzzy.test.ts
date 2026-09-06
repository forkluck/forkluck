import { describe, expect, it } from "vitest"

import { fuzzyMatches } from "@/lib/fuzzy"

// Parity with apps/api/forkluck/test_ingredient_measures.py ("jarlic").
describe("fuzzyMatches", () => {
  it("forgives one typo in a word of four letters or more", () => {
    expect(fuzzyMatches("garlic", "jarlic")).toBe(true)
    expect(fuzzyMatches("garlic", "garlc")).toBe(true)
    expect(fuzzyMatches("black garlic", "garlik")).toBe(true)
  })
  it("still prefixes on short words and exact substrings", () => {
    expect(fuzzyMatches("garlic", "ga")).toBe(true)
    expect(fuzzyMatches("garlic", "ge")).toBe(false)
    expect(fuzzyMatches("garlic powder", "garl pow")).toBe(true)
  })
  it("does not reach across unrelated words", () => {
    expect(fuzzyMatches("garlic", "carrot")).toBe(false)
    expect(fuzzyMatches("egg", "popo")).toBe(false)
  })
})
