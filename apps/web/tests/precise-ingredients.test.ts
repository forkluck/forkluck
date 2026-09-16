import { describe, expect, it } from "vitest"

import { isPreciseIngredient, precisionFor } from "../lib/precise-ingredients"

describe("precise ingredients", () => {
  it("weighs seasonings, leaveners, hydrocolloids and extracts to the tenth", () => {
    for (const name of [
      "Kosher salt",
      "Fleur de sel",
      "Black pepper",
      "Peppercorns, Tellicherry",
      "Cayenne",
      "Smoked paprika",
      "Ground cinnamon",
      "Whole cloves",
      "Cumin seed",
      "Dried oregano",
      "Bay leaves",
      "Instant yeast",
      "Baking soda",
      "Cream of tartar",
      "Xanthan gum",
      "Agar agar",
      "Gelatin sheets",
      "Citric acid",
      "Sodium citrate",
      "Vanilla extract",
      "Red food coloring",
      "Prague powder #1",
    ]) {
      expect(isPreciseIngredient(name), name).toBe(true)
      expect(precisionFor(name)).toBe(1)
    }
  })

  it("leaves bulk ingredients, vegetables and salted goods whole", () => {
    for (const name of [
      "Bread flour",
      "Unsalted butter",
      "Salted butter",
      "Bell pepper",
      "Red peppers",
      "Jalapeño",
      "Garlic cloves",
      "Fresh ginger",
      "Fresh thyme",
      "Chicken stock",
      "Pork Fat Back",
      "Lard Maison",
      "Sugar",
    ]) {
      expect(isPreciseIngredient(name), name).toBe(false)
      expect(precisionFor(name)).toBe(0)
    }
  })

  it("trusts a spice or additive category when the name says nothing", () => {
    expect(isPreciseIngredient("House blend", "Spices")).toBe(true)
    expect(isPreciseIngredient("House blend", "Dairy")).toBe(false)
    expect(isPreciseIngredient(null, null)).toBe(false)
  })
})
