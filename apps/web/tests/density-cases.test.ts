import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { densityGrams } from "@/lib/recipe/density"

/**
 * What a volume of an ingredient weighs by its name alone, pinned as data.
 *
 * `tests/fixtures/density-cases.json` is copied verbatim into the Mac app
 * (`forkluck-macosTests/Fixtures/`), whose Swift port of densityGrams asserts
 * every case. Regenerate with
 * `UPDATE_DENSITY_FIXTURE=1 pnpm exec vitest run tests/density-cases.test.ts`
 * and copy it across.
 */

const FIXTURE = new URL("./fixtures/density-cases.json", import.meta.url)
const GENERATOR =
  "cd apps/web && UPDATE_DENSITY_FIXTURE=1 pnpm exec vitest run tests/density-cases.test.ts"

/** One or more names per rule in data/volume-measures.json, then the traps. */
const NAMES = [
  "Cake flour",
  "Whole wheat flour",
  "Bread Flour",
  "Semolina",
  "Semolina flour",
  "Almond flour",
  "Corn flour",
  "Cornmeal",
  "Cornstarch",
  "Rye flour",
  "All-purpose flour",
  "Flour",
  "Powdered sugar",
  "Confectioners' sugar",
  "Brown sugar",
  "Light brown sugar",
  "Granulated sugar",
  "Sugar",
  "Sanding sugar",
  "Sugar syrup",
  "Sugar Snap Peas",
  "Kosher salt",
  "Diamond Crystal kosher salt",
  "Sea salt",
  "Sea salt caramel",
  "Salt",
  "No salt seasoning",
  "Olive oil",
  "Extra-virgin olive oil",
  "Canola oil",
  "Vegetable oil",
  "Sunflower oil",
  "Sesame oil",
  "Oil",
  "Oil packed tuna",
  "Red wine vinegar",
  "Soy sauce",
  "Shiro miso",
  "Honey",
  "Honeycrisp apples",
  "Honey mustard",
  "Maple syrup",
  "Molasses",
  "Buttermilk",
  "Heavy cream",
  "Sour cream",
  "Coconut milk",
  "Evaporated milk",
  "Sweetened condensed milk",
  "Whole milk",
  "Milk powder",
  "Greek yogurt",
  "Cream cheese",
  "Water",
  "Sparkling water",
  "Coconut water",
  "Baking powder",
  "Baking soda",
  "Cocoa powder",
  "Dutch-process cocoa",
  "Cocoa butter",
  "Cocoa nibs",
  "Peanut butter",
  "Peanut butter powder",
  "Mayonnaise",
  "Ketchup",
  "Tomato sauce",
  "Tomato paste",
  "Rolled oats",
  "Old-fashioned rolled oats",
  "Jasmine rice",
  "Cooked rice",
  "Rice flour",
  "Cauliflower rice",
  "Couscous",
  "Lentils",
  "Canned lentils",
  "Pimentón de la Vera",
  "Saffron threads",
  "",
  "  ",
  "!!!",
]

const UNITS = ["cup", "tbsp", "ml", "tsp", "fl-oz", "l", "g", "each"]

/** A qualifier asks about a state the chart does not describe. */
const QUALIFIED: { name: string; qualifier: string | null }[] = [
  { name: "Canola oil", qualifier: "" },
  { name: "Canola oil", qualifier: null },
  { name: "Canola oil", qualifier: "cold" },
  { name: "Flour", qualifier: "sifted" },
  { name: "Brown sugar", qualifier: "packed" },
  { name: "Pimentón de la Vera", qualifier: "smoked" },
]

function generate() {
  return {
    generator: GENERATOR,
    cases: [
      ...NAMES.flatMap((name) =>
        UNITS.map((unit) => ({
          name,
          amount: 1,
          unit,
          qualifier: null,
          expect: densityGrams(1, unit, name),
        }))
      ),
      ...[0.25, 2.5, 1000].map((amount) => ({
        name: "Honey",
        amount,
        unit: "tbsp",
        qualifier: null,
        expect: densityGrams(amount, "tbsp", "Honey"),
      })),
      ...QUALIFIED.map(({ name, qualifier }) => ({
        name,
        amount: 1,
        unit: "cup",
        qualifier,
        expect: densityGrams(1, "cup", name, qualifier),
      })),
    ],
  }
}

describe("the density fixture the Mac app asserts against", () => {
  it("matches what the shared chart weighs", () => {
    const generated = JSON.parse(JSON.stringify(generate()))
    if (process.env.UPDATE_DENSITY_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
