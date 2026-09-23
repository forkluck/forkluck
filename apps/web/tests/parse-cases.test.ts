import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import corpus from "./fixtures/recipe-lines.json"
import {
  clampRecipeQuantity,
  parseRecipeAmount,
  parseRecipeText,
  recipeIngredientBaseName,
  replaceRecipeIngredientLine,
  replaceRecipeLineWithExplicitWeight,
  roundRecipeQuantity,
  tidyVolume,
} from "../lib/recipe"
import type { ParseRecipeOptions } from "../lib/recipe"

/**
 * Whole pasted documents as the parser reads them, pinned as data.
 *
 * `tests/fixtures/parse-cases.json` is copied verbatim into the Mac app
 * (`forkluck-macosTests/Fixtures/`), whose Swift port of lib/recipe/parse.ts
 * asserts every document's complete result. The inputs are every
 * parseRecipeText call the parse suites make, options included, then the
 * pasted-line corpus. Regenerate with
 * `UPDATE_PARSE_FIXTURE=1 pnpm exec vitest run tests/parse-cases.test.ts` and
 * copy it across.
 */

const FIXTURE = new URL("./fixtures/parse-cases.json", import.meta.url)
const GENERATOR =
  "cd apps/web && UPDATE_PARSE_FIXTURE=1 pnpm exec vitest run tests/parse-cases.test.ts"

/** The documents of the parse suites, each with the options it was read with. */
const DOCUMENTS: { text: string; options?: ParseRecipeOptions }[] = [
  // recipe-parse.test.ts
  {
    text: "500 gr. Bread Flour\n380 gr. Warm Water\n40 gr. Extra Virgin Olive Oil\n10 gr. Fine Sea Salt\n5 gr. Instant Yeast\n8 gr. Honey\n120 gr. Cherry Tomatoes\n4 gr. Fresh Rosemary",
  },
  {
    text: "620 Bread Flour",
    options: {
      identities: [
        {
          id: "pantry-bread-flour",
          name: "Bread Flour",
          normalizedName: "bread flour",
          source: "pantry",
        },
      ],
    },
  },
  { text: "1 chicken bouillon cube\n1 tbsp all purpose flour\n3 eggs" },
  {
    text: "1.5 kg Flour\n20 grams Sugar\n5 g. Salt\n0.25 kilogram Butter\n3 gram Vanilla",
  },
  {
    text: "2 ea Eggs",
    options: {
      identities: [
        {
          id: "pantry-eggs",
          name: "Eggs",
          normalizedName: "eggs",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "2 each Eggs",
    options: {
      identities: [
        {
          id: "pantry-eggs",
          name: "Eggs",
          normalizedName: "eggs",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "2 x Eggs",
    options: {
      identities: [
        {
          id: "pantry-eggs",
          name: "Eggs",
          normalizedName: "eggs",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "2x Eggs",
    options: {
      identities: [
        {
          id: "pantry-eggs",
          name: "Eggs",
          normalizedName: "eggs",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "1 ea Cookie dough",
    options: {
      identities: [
        {
          id: "component-dough",
          name: "Cookie dough",
          normalizedName: "cookie dough",
          source: "component",
          componentYieldAmount: 70,
          componentYieldUnit: "pcs",
        },
      ],
    },
  },
  {
    text: "1 each Cookie dough",
    options: {
      identities: [
        {
          id: "component-dough",
          name: "Cookie dough",
          normalizedName: "cookie dough",
          source: "component",
          componentYieldAmount: 70,
          componentYieldUnit: "pcs",
        },
      ],
    },
  },
  {
    text: "1x Cookie dough",
    options: {
      identities: [
        {
          id: "component-dough",
          name: "Cookie dough",
          normalizedName: "cookie dough",
          source: "component",
          componentYieldAmount: 70,
          componentYieldUnit: "pcs",
        },
      ],
    },
  },
  {
    text: "1 ea Egg",
    options: {
      identities: [
        {
          id: "component-egg",
          name: "Egg",
          normalizedName: "egg",
          source: "component",
          componentYieldAmount: 70,
          componentYieldUnit: "pcs",
        },
      ],
    },
  },
  {
    text: "1 ea Eggs",
    options: {
      identities: [
        {
          id: "component-egg",
          name: "Eggs",
          normalizedName: "eggs",
          source: "component",
          componentYieldAmount: 70,
          componentYieldUnit: "pcs",
        },
      ],
    },
  },
  {
    text: "1 ea Large egg",
    options: {
      identities: [
        {
          id: "component-egg",
          name: "Large egg",
          normalizedName: "large egg",
          source: "component",
          componentYieldAmount: 70,
          componentYieldUnit: "pcs",
        },
      ],
    },
  },
  {
    text: "1 ea Whole egg",
    options: {
      identities: [
        {
          id: "component-egg",
          name: "Whole egg",
          normalizedName: "whole egg",
          source: "component",
          componentYieldAmount: 70,
          componentYieldUnit: "pcs",
        },
      ],
    },
  },
  {
    text: "1 ea Cookie dough",
    options: {
      identities: [
        {
          id: "component-dough",
          name: "Cookie dough",
          normalizedName: "cookie dough",
          source: "component",
        },
      ],
    },
  },
  {
    text: "2 each Eggs (room temperature)",
    options: {
      identities: [
        {
          id: "pantry-eggs",
          name: "Eggs",
          normalizedName: "eggs",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "2 each Eggs (divided)",
    options: {
      identities: [
        {
          id: "pantry-eggs",
          name: "Eggs",
          normalizedName: "eggs",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "Eggs\n2 cups Flour\n3 ea Rosemary\n0 g Salt\n\n12 gr. Sugar",
    options: {
      identities: [
        {
          id: "pantry-flour",
          name: "Flour",
          normalizedName: "flour",
          source: "pantry",
        },
        {
          id: "pantry-rosemary",
          name: "Rosemary",
          normalizedName: "rosemary",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "1 dash Salt",
    options: {
      identities: [
        {
          id: "pantry-salt",
          name: "Salt",
          normalizedName: "salt",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "1 dash Salt",
    options: {
      measures: [
        {
          id: "salt-dash",
          ingredientId: null,
          name: "Salt",
          normalizedName: "salt",
          unit: "dash",
          amount: 1,
          grams: 0.6,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  { text: "1 pinch Salt" },
  {
    text: "1 pinch Saffron",
    options: {
      measures: [
        {
          id: "saffron-pinch",
          ingredientId: null,
          name: "Saffron",
          normalizedName: "saffron",
          unit: "pinch",
          amount: 1,
          grams: 0.05,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "user",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 container, Test ingredient",
    options: {
      measures: [
        {
          id: "test-container",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "container",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 portion, Test ingredient",
    options: {
      measures: [
        {
          id: "test-portion",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "portion",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 serving, Test ingredient",
    options: {
      measures: [
        {
          id: "test-serving",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "serving",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 carton, Test ingredient",
    options: {
      measures: [
        {
          id: "test-carton",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "carton",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 batch, Test ingredient",
    options: {
      measures: [
        {
          id: "test-batch",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "batch",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 dozen, Test ingredient",
    options: {
      measures: [
        {
          id: "test-dozen",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "dozen",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 sheet, Test ingredient",
    options: {
      measures: [
        {
          id: "test-sheet",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "sheet",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 sprig, Test ingredient",
    options: {
      measures: [
        {
          id: "test-sprig",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "sprig",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 stalk, Test ingredient",
    options: {
      measures: [
        {
          id: "test-stalk",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "stalk",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 case, Test ingredient",
    options: {
      measures: [
        {
          id: "test-case",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "case",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 head, Test ingredient",
    options: {
      measures: [
        {
          id: "test-head",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "head",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 leaf, Test ingredient",
    options: {
      measures: [
        {
          id: "test-leaf",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "leaf",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 loaf, Test ingredient",
    options: {
      measures: [
        {
          id: "test-loaf",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "loaf",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 pack, Test ingredient",
    options: {
      measures: [
        {
          id: "test-pack",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "pack",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 tray, Test ingredient",
    options: {
      measures: [
        {
          id: "test-tray",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "tray",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 ear, Test ingredient",
    options: {
      measures: [
        {
          id: "test-ear",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "ear",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 fl-oz, Test ingredient",
    options: {
      measures: [
        {
          id: "test-fl-oz",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "fl-oz",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 tbsp, Test ingredient",
    options: {
      measures: [
        {
          id: "test-tbsp",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "tbsp",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 tsp, Test ingredient",
    options: {
      measures: [
        {
          id: "test-tsp",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "tsp",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 ml, Test ingredient",
    options: {
      measures: [
        {
          id: "test-ml",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "ml",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 l, Test ingredient",
    options: {
      measures: [
        {
          id: "test-l",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "l",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 gal, Test ingredient",
    options: {
      measures: [
        {
          id: "test-gal",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "gal",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 qt, Test ingredient",
    options: {
      measures: [
        {
          id: "test-qt",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "qt",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 pt, Test ingredient",
    options: {
      measures: [
        {
          id: "test-pt",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "pt",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup, Test ingredient",
    options: {
      measures: [
        {
          id: "test-cup",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "cup",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 clove, Test ingredient",
    options: {
      measures: [
        {
          id: "test-clove",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "clove",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 stick, Test ingredient",
    options: {
      measures: [
        {
          id: "test-stick",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "stick",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 slice, Test ingredient",
    options: {
      measures: [
        {
          id: "test-slice",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "slice",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 can, Test ingredient",
    options: {
      measures: [
        {
          id: "test-can",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "can",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 jar, Test ingredient",
    options: {
      measures: [
        {
          id: "test-jar",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "jar",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 bottle, Test ingredient",
    options: {
      measures: [
        {
          id: "test-bottle",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "bottle",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 bag, Test ingredient",
    options: {
      measures: [
        {
          id: "test-bag",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "bag",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 box, Test ingredient",
    options: {
      measures: [
        {
          id: "test-box",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "box",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 packet, Test ingredient",
    options: {
      measures: [
        {
          id: "test-packet",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "packet",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 dash, Test ingredient",
    options: {
      measures: [
        {
          id: "test-dash",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "dash",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 bunch, Test ingredient",
    options: {
      measures: [
        {
          id: "test-bunch",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "bunch",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 each, Test ingredient",
    options: {
      measures: [
        {
          id: "test-each",
          ingredientId: null,
          name: "Test ingredient",
          normalizedName: "test ingredient",
          unit: "each",
          amount: 1,
          grams: 25,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  { text: "1 fl. oz. Test ingredient" },
  { text: "1 fluid ounce Test ingredient" },
  { text: "1 tablespoon Test ingredient" },
  { text: "1 tsp. Test ingredient" },
  { text: "1 millilitre Test ingredient" },
  { text: "1 litre Test ingredient" },
  { text: "1 tin Test ingredient" },
  { text: "1 package Test ingredient" },
  { text: "1 pinch Test ingredient" },
  { text: "1 bunch Test ingredient" },
  {
    text: "• 1 cup of All-purpose flour\n- 1 cup of All-purpose flour",
    options: {
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  { text: "1 lb Butter\n8 oz Sugar\n2 pounds Bread Flour\n4 ozs. Honey" },
  {
    text: "butter 810\npowder sugar 200\nap flour\tgr\t1000\nkosher salt    14\nsugar 210 g",
    options: {
      identities: [
        {
          id: "pantry-butter",
          name: "butter",
          normalizedName: "butter",
          source: "pantry",
        },
        {
          id: "pantry-powder-sugar",
          name: "powder sugar",
          normalizedName: "powder sugar",
          source: "pantry",
        },
        {
          id: "pantry-kosher-salt",
          name: "kosher salt",
          normalizedName: "kosher salt",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "oven to 175\nbake 12 minutes\nrest the dough for 30\nbake until 20",
  },
  { text: "mystery ml 200\ncream 200 ml" },
  {
    text: "2 cups All-purpose flour\n118.29411825 ml All-purpose flour",
    options: {
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup AP flour",
    options: {
      matches: [{ line: "ap flour", targetId: "pantry-flour" }],
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
        {
          id: "user-flour",
          ingredientId: "pantry-flour",
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 130,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "user",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup AP flour",
    options: {
      matches: [
        {
          line: "ap flour",
          targetId: "pantry-flour",
          targetName: "All-purpose flour",
          targetKind: "ingredient",
        },
      ],
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup AP flour",
    options: {
      identities: [
        {
          id: "pantry-bread-flour",
          name: "Bread Flour",
          normalizedName: "bread flour",
          source: "pantry",
        },
      ],
      matches: [
        {
          line: "ap flour",
          targetId: "pantry-bread-flour",
          targetName: "Bread Flour",
          targetKind: "ingredient",
        },
      ],
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup AP flour",
    options: {
      identities: [
        {
          id: "pantry-bread-flour",
          name: "Bread Flour",
          normalizedName: "bread flour",
          source: "pantry",
        },
      ],
      matches: [{ line: "ap flour", targetId: "pantry-bread-flour" }],
      measures: [
        {
          id: "other-pantry-flour",
          ingredientId: "pantry-all-purpose-flour",
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "user",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup Powdered sugar, sifted",
    options: {
      matches: [{ line: "powdered sugar", targetId: "pantry-sugar" }],
      measures: [
        {
          id: "sifted-sugar",
          ingredientId: "pantry-sugar",
          name: "Confectioners sugar",
          normalizedName: "confectioners sugar",
          unit: "cup",
          amount: 1,
          grams: 110,
          lowGrams: null,
          highGrams: null,
          qualifier: "sifted",
          source: "user",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup chopped Onions",
    options: {
      measures: [
        {
          id: "chopped-onions",
          ingredientId: null,
          name: "Onions",
          normalizedName: "onions",
          unit: "cup",
          amount: 1,
          grams: 160,
          lowGrams: null,
          highGrams: null,
          qualifier: "chopped",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  { text: "50 g almond sliced" },
  { text: "50 g tomato diced" },
  { text: "50 g coconut shredded" },
  { text: "50 g pepper crushed" },
  { text: "50 g sliced almond" },
  { text: "50 g diced tomato" },
  { text: "50 g shredded coconut" },
  { text: "50 g crushed pepper" },
  { text: "50 g almond, sliced" },
  { text: "50 g tomato (diced)" },
  {
    text: "1 cup All-purpose flour (divided)",
    options: {
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup All-purpose flour (sifted), divided",
    options: {
      measures: [
        {
          id: "sifted-flour-composed",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 120,
          lowGrams: null,
          highGrams: null,
          qualifier: "sifted",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup All-purpose flour (sifted) (divided)",
    options: {
      measures: [
        {
          id: "sifted-flour-composed",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 120,
          lowGrams: null,
          highGrams: null,
          qualifier: "sifted",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup All-purpose flour, sifted (divided)",
    options: {
      measures: [
        {
          id: "sifted-flour-composed",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 120,
          lowGrams: null,
          highGrams: null,
          qualifier: "sifted",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup All-purpose flour, sifted (room temperature)",
    options: {
      measures: [
        {
          id: "sifted-flour-composed",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 120,
          lowGrams: null,
          highGrams: null,
          qualifier: "sifted",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 tbsp Brown sugar (packed)",
    options: {
      measures: [
        {
          id: "generic-sugar",
          ingredientId: null,
          name: "Brown sugar",
          normalizedName: "brown sugar",
          unit: "cup",
          amount: 1,
          grams: 200,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
        {
          id: "packed-cup",
          ingredientId: null,
          name: "Brown sugar",
          normalizedName: "brown sugar",
          unit: "cup",
          amount: 1,
          grams: 220,
          lowGrams: null,
          highGrams: null,
          qualifier: "packed",
          source: "catalog",
          confidence: "high",
        },
        {
          id: "packed-tablespoon",
          ingredientId: null,
          name: "Brown sugar",
          normalizedName: "brown sugar",
          unit: "tbsp",
          amount: 1,
          grams: 13.5,
          lowGrams: null,
          highGrams: null,
          qualifier: "packed",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "2 cups All-purpose flour",
    options: {
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: 100,
          highGrams: 150,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1 cup All-purpose flour (sifted)",
    options: {
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  { text: "1 cup Brown sugar, packed" },
  {
    text: "1 cup (120 g) All-purpose flour",
    options: {
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  { text: "2 cans (14 oz) Tomatoes" },
  { text: "2 jars (16 oz) Tomatoes" },
  { text: "2 bottles (16 oz each) Tomato juice" },
  { text: "2 (16 oz) bags Frozen peas" },
  { text: "2 boxes (16 oz) Pasta" },
  { text: "2 cans (14-ounce) Diced tomatoes" },
  { text: "2 14-ounce cans Diced tomatoes" },
  { text: "2 cups (240 g) All-purpose flour" },
  {
    text: "2 cups (120 g each) All-purpose flour\n2 cups (240 g total) All-purpose flour",
  },
  {
    text: "½ cup All-purpose flour\n1½ cups All-purpose flour",
    options: {
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  {
    text: "1–2 cups All-purpose flour",
    options: {
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  { text: "1–2 hours rest" },
  { text: "Blind-bake the tart shells.\n2 cups\n1–2 hours resting" },
  { text: "1. Mix the dough\n2) Rest 30 minutes" },
  { text: "650 g Bread Flour\n2 400 g cans Diced tomatoes\n8 g Kosher Salt" },
  {
    text: "1.5 kg Flour\n2 kg Flour\n1 egg\n500 g Bread Flour",
    options: {
      identities: [
        {
          id: "pantry-egg",
          name: "egg",
          normalizedName: "egg",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "2 garlic cloves\n2 tomatoes\n4 cherry tomatoes",
    options: {
      identities: [
        {
          id: "pantry-garlic-cloves",
          name: "garlic cloves",
          normalizedName: "garlic cloves",
          source: "pantry",
        },
        {
          id: "pantry-tomatoes",
          name: "tomatoes",
          normalizedName: "tomatoes",
          source: "pantry",
        },
        {
          id: "pantry-cherry-tomatoes",
          name: "cherry tomatoes",
          normalizedName: "cherry tomatoes",
          source: "pantry",
        },
      ],
    },
  },
  { text: "Filling\nEggs\n0 g Salt" },
  {
    text: "Dough:\n# Toppings\nNote: chill 1 hr\nKosher salt, to taste\n1 tsp Salt:",
  },
  { text: "salt to taste\nsalt, to taste\nolive oil for brushing" },
  {
    text: "20–25 minutes at 350F\n2–3 hours resting\n1–2 cups All-purpose flour",
  },
  { text: "200 ml Mystery sauce" },
  { text: "1 cup Mystery sauce\nMix well." },
  { text: "2 each Eggs" },
  { text: "2 each (100 g total) Eggs" },
  { text: "1 tbsp WWV" },
  {
    text: "1 tbsp WWV",
    options: {
      identities: [
        {
          id: "pantry-wwv",
          name: "White Wine Vinegar",
          normalizedName: "white wine vinegar",
          source: "pantry",
        },
      ],
      matches: [{ line: "wwv", targetId: "pantry-wwv" }],
    },
  },
  {
    text: "1 cup flour",
    options: {
      identities: [
        {
          id: "pantry-oil",
          name: "Olive Oil",
          normalizedName: "olive oil",
          source: "pantry",
        },
      ],
      matches: [{ line: "flour", targetId: "pantry-oil" }],
    },
  },
  { text: "1 cup Sugar Snap Peas" },
  {
    text: "1 cup Sugar\n1 cup All-purpose flour",
    options: {
      identities: [
        {
          id: "pantry-sugar",
          name: "Sugar",
          normalizedName: "sugar",
          source: "pantry",
        },
        {
          id: "pantry-all-purpose-flour",
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          source: "pantry",
        },
      ],
    },
  },
  { text: "1 cup Pimentón de la Vera" },
  {
    text: "1 cup Pimentón de la Vera",
    options: {
      identities: [
        {
          id: "pantry-piment-n-de-la-vera",
          name: "Pimentón de la Vera",
          normalizedName: "pimenton de la vera",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "1 cup Peanut Butter Powder\n1 cup Steel Cut Oats\n1 cup Cauliflower Rice",
  },
  {
    text: "1 cup Cocoa Powder\n1 cup Granulated Sugar\n1 cup Semolina Flour\n1 cup Rolled Oats",
    options: {
      identities: [
        {
          id: "pantry-cocoa-powder",
          name: "Cocoa Powder",
          normalizedName: "cocoa powder",
          source: "pantry",
        },
        {
          id: "pantry-granulated-sugar",
          name: "Granulated Sugar",
          normalizedName: "granulated sugar",
          source: "pantry",
        },
        {
          id: "pantry-semolina-flour",
          name: "Semolina Flour",
          normalizedName: "semolina flour",
          source: "pantry",
        },
        {
          id: "pantry-rolled-oats",
          name: "Rolled Oats",
          normalizedName: "rolled oats",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "1 cup Honey",
    options: {
      identities: [
        {
          id: "component-honey",
          name: "Honey",
          normalizedName: "honey",
          source: "component",
        },
      ],
    },
  },
  {
    text: "1 cup All-purpose flour",
    options: {
      measures: [
        {
          id: "catalog-flour-cup",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 125,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
        {
          id: "catalog-flour-cup-duplicate",
          ingredientId: null,
          name: "All-purpose flour",
          normalizedName: "all purpose flour",
          unit: "cup",
          amount: 1,
          grams: 200,
          lowGrams: null,
          highGrams: null,
          qualifier: "",
          source: "catalog",
          confidence: "high",
        },
      ],
    },
  },
  { text: "620 Bread Flour" },
  { text: "3 eggs" },
  { text: "2 large Eggs" },
  { text: "1 extra large egg" },
  { text: "2 jumbo Eggs" },
  { text: "1 medium onion" },
  { text: "2 ea Eggs" },
  { text: "24 pcs Scallion Greens" },
  { text: "1 piece Eggplant" },
  { text: "2 pc Lemons" },
  { text: "3 pieces Focaccia" },
  { text: "1 cup Milk" },
  { text: "1 1/2 cups water" },
  { text: "1 1/2 cups water" },
  { text: "1½ cups milk" },
  { text: "1⁄2 cup Milk" },
  { text: "​1 cup Milk" },
  { text: "1,500 g flour" },
  { text: "1,5 kg Sugar" },
  { text: "1 cup sifted flour" },
  { text: "1 cup flour, sifted" },
  { text: "1 cup packed brown sugar" },
  { text: "1 cup brown sugar, packed" },
  { text: "1 cup melted butter" },
  { text: "1 cup butter, melted" },
  { text: "1/2 tsp salt, or to taste" },
  { text: "2 tablespoons (30ml) vegetable oil" },
  { text: "1 cup Milk (240 ml)" },
  { text: "1 (14 oz) can diced tomatoes" },
  { text: "2 cups (120 g each) Flour" },
  { text: "2 x 400 g cans Chopped Tomatoes" },
  { text: "2 5 g packets Yeast" },
  { text: "2 pkg Yeast" },
  { text: "2 pkgs Yeast" },
  { text: "2 T Sugar" },
  { text: "8 oz milk" },
  { text: "1 lb Butter" },
  { text: "100 g milk" },
  { text: "Flour 250 g" },
  { text: "kosher salt 14" },
  { text: "2 tablespoons plus 1 teaspoon sugar" },
  { text: "2 1/2 cups + 2 tbsp bread flour" },
  { text: "1-2 tbsp olive oil" },
  { text: "20-25 min" },
  { text: "180-200 C, fan" },
  { text: "20-25 minutes at 350F" },
  { text: "1-2 c flour" },
  { text: "▢ 620 Bread Flour" },
  { text: "▢1 pound ground beef" },
  { text: "☐ 1 cup Milk" },
  { text: "□ 2 cups water" },
  { text: "✓ 1 tablespoon olive oil" },
  { text: "6 cloves garlic, pressed or minced" },
  { text: "8 oz mushrooms, cleaned + sliced" },
  { text: "2 lb tomatoes, peeled and crushed" },
  { text: "1 cup flour, sifted (room temperature)" },
  { text: "Drizzle of avocado oil" },
  { text: "Filling" },
  { text: "1 chicken bouillon cube" },
  { text: "1 tbsp all purpose flour" },
  { text: "3 1/2 to 4 cups all-purpose flour" },
  { text: "Dough:" },
  { text: "# Choc chips" },
  { text: "Note: chill 1 hr" },
  { text: "Kosher salt, to taste" },
  { text: "extra-virgin olive oil, for brushing" },
  { text: "garlic cloves, minced (optional)" },
  { text: "1 Tablespoon (13g) unsalted butter" },
  { text: "(1lb/454g) shredded mozzarella cheese" },
  { text: "(30ml) extra-virgin olive oil, plus more for greasing" },
  { text: "153 grams 00 flour (1 cup plus 1 tablespoon)" },
  { text: "1 large yellow onion, coarsely chopped" },
  { text: "2 cups mango chunks, (2 large mangoes) (fresh or frozen)" },
  { text: "1 tsp salt, divided" },
  {
    text: 'Dough:\n- 226 g unsalted butter, cut into 1cm / 1/2" cubes\n- 3 1/2 to 4 cups all-purpose flour\n- 1 tsp kosher salt, halve for table salt, +50% for flakes\n- 2 large eggs\nToppings (optional):\n- 1 cup (170 g) chocolate chips\n- flaky sea salt, for sprinkling\nNote: chill the dough for an hour',
    options: {
      identities: [
        {
          id: "pantry-eggs",
          name: "eggs",
          normalizedName: "eggs",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: "# Base\n2 cups mango chunks, (2 large mangoes) (fresh or frozen)\n(1lb/454g) shredded mozzarella cheese\n(30ml) extra-virgin olive oil, plus more for greasing\n1 Tablespoon (13g) tomato paste\nKosher salt, to taste\n1. Heat the oven to 250C",
    options: {
      identities: [
        {
          id: "pantry-eggs",
          name: "eggs",
          normalizedName: "eggs",
          source: "pantry",
        },
      ],
    },
  },
  {
    text: 'Dough:\n- 226 g unsalted butter, cut into 1cm / 1/2" cubes\n- 3 1/2 to 4 cups all-purpose flour\n- 1 tsp kosher salt, halve for table salt, +50% for flakes\n- 2 large eggs\nToppings (optional):\n- 1 cup (170 g) chocolate chips\n- flaky sea salt, for sprinkling\nNote: chill the dough for an hour',
  },
  {
    text: "1 large egg",
    options: {
      identities: [
        {
          id: "pantry-egg",
          name: "egg",
          normalizedName: "egg",
          source: "pantry",
        },
      ],
    },
  },
  { text: "1 large bowl" },
  { text: "1 1/3 cups water" },
  {
    text: "# Base\n2 cups mango chunks, (2 large mangoes) (fresh or frozen)\n(1lb/454g) shredded mozzarella cheese\n(30ml) extra-virgin olive oil, plus more for greasing\n1 Tablespoon (13g) tomato paste\nKosher salt, to taste\n1. Heat the oven to 250C",
  },
  // recipe-parse-notes.test.ts
  { text: "1/3 cup lemon zest (1 ounce; 28 g) from 6 medium lemons" },
  { text: "1 cup (240 ml) lemon juice from 6 medium lemons" },
  {
    text: "1/4 teaspoon Diamond Crystal kosher salt; for table salt, use half as much by volume",
  },
  { text: "3/4 cup granulated sugar (5 1/4 ounces; 150 g)" },
  { text: "5 tablespoons unsalted butter (2 1/2 ounces; 70 g), softened" },
  { text: "3 large eggs" },
  { text: "3 large egg yolks" },
  { text: "1 each Tart Crust, baked and cooled" },
  { text: "2 3/4 cups Lemon Curd" },
  { text: "1 1/4 cups all-purpose flour (5 1/2 ounces; 160 g)" },
  { text: "1/3 cup granulated sugar (2 1/3 ounces; 65 g)" },
  { text: "1/4 teaspoon Diamond Crystal kosher salt" },
  { text: "8 tablespoons unsalted butter (4 ounces; 113 g), melted" },
  { text: "1/2 teaspoon vanilla extract" },
  {
    text: "1/3 cup lemon zest (1 ounce; 28 g) from 6 medium lemons\n1 cup (240 ml) lemon juice from 6 medium lemons\n1/4 teaspoon Diamond Crystal kosher salt; for table salt, use half as much by volume\n3/4 cup granulated sugar (5 1/4 ounces; 150 g)\n5 tablespoons unsalted butter (2 1/2 ounces; 70 g), softened\n3 large eggs\n3 large egg yolks\n1 each Tart Crust, baked and cooled\n2 3/4 cups Lemon Curd\n1 1/4 cups all-purpose flour (5 1/2 ounces; 160 g)\n1/3 cup granulated sugar (2 1/3 ounces; 65 g)\n1/4 teaspoon Diamond Crystal kosher salt\n8 tablespoons unsalted butter (4 ounces; 113 g), melted\n1/2 teaspoon vanilla extract",
  },
  { text: "1 tsp kosher salt, halve for table salt, +50% for flakes" },
  // recipe-analysis.test.ts
  { text: "100 g Granulated sugar\n200 ml Mystery sauce" },
  // recipe-markdown.test.ts
  {
    text: "# Focaccia\n\n## Dough\n- 500 g Bread flour\n- 10.5 g Fine sea salt\n- 1 1/2 cup Water, lukewarm\n- 2 ea Egg\n\n## Topping\n- 250 g Tomato sauce\n- Olive oil, for brushing\n> Rest overnight for the best flavour\n\n## Tomato sauce\n- 200 g Tomatoes\n- 10 g Olive oil\n> Simmer until thick",
  },
  // recipe-scale.test.ts
  { text: "2 kg (1500 g total) Flour" },
  { text: "500 gr. Bread Flour\n2 kg Water" },
  {
    text: "1 ea Cookie jam",
    options: {
      identities: [
        {
          id: "jam",
          name: "Cookie jam",
          normalizedName: "cookie jam",
          source: "component",
          componentYieldAmount: 60,
          componentYieldUnit: "pcs",
        },
      ],
    },
  },
  { text: "2 400 g cans Diced tomatoes" },
  { text: "3 400 g cans Diced tomatoes" },
  { text: "2 250 g boxes Pasta" },
  { text: "3 100 g jars Honey" },
  { text: "2 20 g cloves Garlic" },
  { text: "4 15 g bunches Basil" },
]

/** Amounts as a cook types them, including the vulgar fractions. */
const AMOUNTS = [
  "1",
  "1.5",
  ".5",
  "1/2",
  "1 1/2",
  "2 3/4",
  "1,000",
  "1,234.5",
  "½",
  "1½",
  "1 ½",
  "⅓",
  "¾",
  "⅛",
  "1/0",
  "0",
  "",
  "  ",
  "abc",
  "1/2/3",
  "1 2 3",
  "3.333333333",
  "-1",
  "1e3",
  "0x10",
]

/** Names the parser reduces to an identity, from the suites and the corpus. */
const NAMES = [
  "Bread Flour",
  "All-purpose flour (divided)",
  "Brown sugar, packed",
  "large eggs",
  "Eggs, beaten",
  "Unsalted butter, softened; cubed",
  "Onions, finely chopped",
  "chopped Onions",
  "Powdered sugar, sifted",
  "Diced tomatoes (drained)",
  "Tomatoes (14 oz)",
  "extra-virgin olive oil, for brushing",
  "fresh basil leaves, torn",
  "salt, to taste",
  "Pimentón de la Vera",
  "",
]

const VOLUMES: { amount: number; unit: string }[] = [
  { amount: 6, unit: "tsp" },
  { amount: 48, unit: "tsp" },
  { amount: 32, unit: "tbsp" },
  { amount: 4.5, unit: "tsp" },
  { amount: 2, unit: "tsp" },
  { amount: 7, unit: "cup" },
]

function generate() {
  const corpusLines: { text: string; options?: ParseRecipeOptions }[] = (
    corpus as { lines: { line: string }[] }
  ).lines.map((entry) => ({ text: entry.line }))
  return {
    generator: GENERATOR,
    documents: [...DOCUMENTS, ...corpusLines].map(({ text, options }) => ({
      text,
      options: options ?? null,
      expect: parseRecipeText(text, options),
    })),
    parseRecipeAmount: AMOUNTS.map((input) => ({
      input,
      expect: parseRecipeAmount(input),
    })),
    recipeIngredientBaseName: NAMES.map((input) => ({
      input,
      expect: recipeIngredientBaseName(input),
    })),
    roundRecipeQuantity: [1 / 3, 2 / 3, 0.1 + 0.2, 1.0000005, 1234.5678915].map(
      (value) => ({ value, expect: roundRecipeQuantity(value) })
    ),
    clampRecipeQuantity: [1.333333, "2.50000"].map((amount) => ({
      amount,
      expect: clampRecipeQuantity(amount),
    })),
    tidyVolume: VOLUMES.map(({ amount, unit }) => ({
      amount,
      unit,
      expect: tidyVolume(amount, unit),
    })),
    replaceRecipeIngredientLine: [
      {
        text: "30 g puffed millet\r\n360 g peanuts\r\nBake until crisp.",
        lineNumber: 2,
        ingredient: { name: "unsalted peanuts", grams: 375.5 },
      },
    ].map((entry) => ({
      ...entry,
      expect: replaceRecipeIngredientLine(
        entry.text,
        entry.lineNumber,
        entry.ingredient
      ),
    })),
    replaceRecipeLineWithExplicitWeight: [
      { text: "1 cup Mystery sauce\nMix well.", grams: 245 },
      { text: "2 each Eggs", grams: 100 },
    ].map(({ text, grams }) => {
      const [line] = [
        ...parseRecipeText(text).unresolvedLines,
        ...parseRecipeText(text).parsedLines,
      ]
      return {
        text,
        line,
        grams,
        expect: replaceRecipeLineWithExplicitWeight(text, line, grams),
      }
    }),
  }
}

describe("the parse fixture the Mac app asserts against", () => {
  it("matches what the parser reads", () => {
    const generated = JSON.parse(JSON.stringify(generate()))
    if (process.env.UPDATE_PARSE_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
