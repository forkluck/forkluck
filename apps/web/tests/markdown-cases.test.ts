import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  recipeMarkdown,
  type MarkdownRecipeLine,
  type MarkdownSubrecipe,
} from "@/lib/recipe/markdown"

/**
 * A recipe copied as markdown, pinned as data.
 *
 * `tests/fixtures/markdown-cases.json` is copied verbatim into the Mac app
 * (`forkluck-macosTests/Fixtures/`), whose Swift port of recipeMarkdown
 * asserts every case. A sub-recipe line names its child by `subrecipeKey`
 * into the case's `subrecipes`; two lines naming one key are one child, as
 * two lines sharing one object are on the web. Regenerate with
 * `UPDATE_MARKDOWN_FIXTURE=1 pnpm exec vitest run tests/markdown-cases.test.ts`
 * and copy it across.
 */

const FIXTURE = new URL("./fixtures/markdown-cases.json", import.meta.url)
const GENERATOR =
  "cd apps/web && UPDATE_MARKDOWN_FIXTURE=1 pnpm exec vitest run tests/markdown-cases.test.ts"

type Line = Omit<MarkdownRecipeLine, "subrecipe"> & { subrecipeKey?: string }
type Child = Omit<MarkdownSubrecipe, "items"> & { items: Line[] }

// The builders and literals of recipe-markdown.test.ts.
const line = (overrides: Partial<Line>): Line => ({
  kind: "ingredient",
  displayName: "Bread flour",
  quantity: 500,
  unit: "g",
  preparationNote: "",
  ...overrides,
})
const section = (name: string): Line =>
  line({ kind: "header", displayName: name, quantity: null, unit: "" })
const note = (text: string): Line =>
  line({ kind: "note", displayName: text, quantity: null, unit: "" })

const SAUCE: Child = {
  title: "Tomato sauce",
  yieldAmount: 1000,
  yieldUnit: "g",
  items: [
    line({ displayName: "Tomatoes", quantity: 800 }),
    line({ displayName: "Olive oil", quantity: 40 }),
    note("Simmer until thick"),
  ],
}

const GLAZE: Child = {
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

const PASTRY: Child = {
  title: "Pastry",
  yieldAmount: null,
  yieldUnit: null,
  items: [line({ displayName: "Butter", quantity: 250 })],
}

const TART: Child = {
  title: "Tart",
  yieldAmount: 8,
  yieldUnit: "slice",
  items: [
    line({ displayName: "Butter", quantity: 250 }),
    line({ displayName: "Eggs", quantity: 3, unit: "each" }),
    line({ displayName: "Milk", quantity: 1, unit: "cup" }),
  ],
}

const FOCACCIA: Line[] = [
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
    subrecipeKey: "sauce",
  }),
  line({
    displayName: "Olive oil",
    quantity: null,
    unit: "",
    preparationNote: "for brushing",
  }),
  note("Rest overnight for the best flavour"),
]

type Case = {
  title: string
  items: Line[]
  scale: number
  subrecipes: Record<string, Child>
}

const CASES: Case[] = [
  {
    title: "Focaccia",
    items: FOCACCIA,
    scale: 1,
    subrecipes: { sauce: SAUCE },
  },
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
        subrecipeKey: "sauce",
      }),
    ],
    scale: 1.5,
    subrecipes: { sauce: SAUCE },
  },
  {
    title: "Buns",
    items: [30, 20].map((quantity) =>
      line({
        kind: "subrecipe",
        displayName: "Glaze",
        quantity,
        unit: "g",
        subrecipeKey: "glaze",
      })
    ),
    scale: 1,
    subrecipes: { glaze: GLAZE },
  },
  {
    title: "Tart",
    items: [
      line({
        kind: "subrecipe",
        displayName: "Pastry",
        quantity: 1,
        unit: "each",
        subrecipeKey: "pastry",
      }),
    ],
    scale: 1,
    subrecipes: { pastry: PASTRY },
  },
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
        subrecipeKey: "untitled",
      }),
    ],
    scale: 1,
    subrecipes: { untitled: { ...SAUCE, title: "" } },
  },
  { title: "", items: [], scale: 1, subrecipes: {} },
  // Beyond the suite: other batches, a counted child, a child with no amount.
  {
    title: "Focaccia",
    items: FOCACCIA,
    scale: 0.5,
    subrecipes: { sauce: SAUCE },
  },
  {
    title: "Focaccia",
    items: FOCACCIA,
    scale: 3,
    subrecipes: { sauce: SAUCE },
  },
  {
    title: "Tart plate",
    items: [
      line({
        kind: "subrecipe",
        displayName: "Tart",
        quantity: 2,
        unit: "slice",
        subrecipeKey: "tart",
      }),
      line({
        kind: "subrecipe",
        displayName: "Tart",
        quantity: null,
        unit: "",
        subrecipeKey: "tart",
      }),
    ],
    scale: 2,
    subrecipes: { tart: TART },
  },
  {
    title: "Tart plate",
    items: [
      line({
        kind: "subrecipe",
        displayName: "Tart",
        quantity: 4,
        unit: "slice",
        subrecipeKey: "tart",
      }),
      line({ displayName: "Cream", quantity: 0.333333, unit: "cup" }),
      line({ displayName: "Vanilla", quantity: 1, unit: "tsp" }),
    ],
    scale: 1.5,
    subrecipes: { tart: TART },
  },
]

/** The web's lines, with every sub-recipe key turned back into one object. */
function webLines(
  items: Line[],
  children: Map<string, MarkdownSubrecipe>
): MarkdownRecipeLine[] {
  return items.map(({ subrecipeKey, ...rest }) => ({
    ...rest,
    ...(subrecipeKey ? { subrecipe: children.get(subrecipeKey) } : {}),
  }))
}

function generate() {
  return {
    generator: GENERATOR,
    cases: CASES.map((entry) => {
      const children = new Map<string, MarkdownSubrecipe>()
      for (const [key, child] of Object.entries(entry.subrecipes)) {
        children.set(key, { ...child, items: webLines(child.items, children) })
      }
      return {
        ...entry,
        expect: recipeMarkdown(
          { title: entry.title, items: webLines(entry.items, children) },
          entry.scale
        ),
      }
    }),
  }
}

describe("the markdown fixture the Mac app asserts against", () => {
  it("matches what Copy as Markdown writes", () => {
    const generated = JSON.parse(JSON.stringify(generate()))
    if (process.env.UPDATE_MARKDOWN_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
