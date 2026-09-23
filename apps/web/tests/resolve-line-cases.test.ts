import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  resolveLine,
  type ResolvableLine,
  type ResolveCatalogRow,
  type ResolveIngredientTarget,
  type ResolveRecipeTarget,
} from "@/lib/recipe/resolve-line"

/**
 * What a written line links to, pinned as data.
 *
 * `tests/fixtures/resolve-line-cases.json` is copied verbatim into the Mac app
 * (`forkluck-macosTests/Fixtures/`), whose Swift port of resolveLine asserts
 * every case against a synchronous stub catalog: a search for `query` answers
 * `catalog.byQuery[query]` when present and `catalog.items` otherwise, and
 * activating a card answers `activations[cardId]`, or `{"error": "no"}` when
 * the card is not listed. `calls` records the searches and activations the web
 * made, in order. Regenerate with
 * `UPDATE_RESOLVE_LINE_FIXTURE=1 pnpm exec vitest run tests/resolve-line-cases.test.ts`
 * and copy it across.
 */

const FIXTURE = new URL("./fixtures/resolve-line-cases.json", import.meta.url)
const GENERATOR =
  "cd apps/web && UPDATE_RESOLVE_LINE_FIXTURE=1 pnpm exec vitest run tests/resolve-line-cases.test.ts"

type Activation = { id: string; name: string; preparations: string[] }

type Case = {
  name: string
  line: ResolvableLine
  ingredients: ResolveIngredientTarget[]
  recipes: ResolveRecipeTarget[]
  catalog: {
    items: ResolveCatalogRow[]
    byQuery?: Record<string, ResolveCatalogRow[]>
  }
  activations: Record<string, Activation>
}

// The pantry and recipe of resolve-line.test.ts.
const EGG = { id: "pantry-egg", name: "Egg", preparations: ["large", "medium"] }
const CURD = { id: "rec-curd", publicId: "rcp_curd", title: "Lemon Curd" }

const base = (fields: Partial<Case> & Pick<Case, "name" | "line">): Case => ({
  ingredients: [EGG],
  recipes: [CURD],
  catalog: { items: [] },
  activations: {},
  ...fields,
})

const DIAMOND = {
  baseName: "Diamond Crystal kosher salt",
  identityCandidates: ["diamond crystal kosher salt", "kosher salt", "salt"],
}

/** Every resolveLine call of resolve-line.test.ts, then a few more. */
const CASES: Case[] = [
  base({
    name: "links a plural to the pantry row that stocks it",
    line: { baseName: "eggs" },
    ingredients: [{ id: "pantry-egg", name: "Egg" }],
  }),
  base({
    name: "leaves an archived pantry row for the catalog to answer",
    line: { baseName: "eggs" },
    ingredients: [{ id: "pantry-egg", name: "Egg", status: "archived" }],
  }),
  base({
    name: "reads a size word as the preparation it names",
    line: {
      baseName: "large eggs",
      identityCandidates: ["egg"],
      sizeWord: "large",
    },
  }),
  base({
    name: "keeps the note the line already carried, preparation first",
    line: {
      baseName: "large eggs",
      noteText: "2 ounces; 56 g",
      identityCandidates: ["egg"],
      sizeWord: "large",
    },
  }),
  base({
    name: "falls back to the qualifier when the line has no written note",
    line: { baseName: "eggs", qualifier: "beaten" },
    ingredients: [{ id: "pantry-egg", name: "Egg" }],
  }),
  base({
    name: "links a title the cook already has as a recipe",
    line: { baseName: "lemon curd" },
  }),
  base({
    name: "prefers the pantry over a recipe of the same name",
    line: { baseName: "Lemon Curd" },
    ingredients: [{ id: "pantry-curd", name: "Lemon curd" }],
  }),
  base({
    name: "pulls an exact catalog match into the pantry",
    line: { baseName: "lemon juice" },
    catalog: {
      items: [
        { id: "cat-other", name: "Lemon zest" },
        { id: "cat-juice", name: "Lemon juice", preparations: [] },
      ],
    },
    activations: {
      "cat-juice": {
        id: "pantry-juice",
        name: "Lemon juice",
        preparations: [],
      },
    },
  }),
  base({
    name: "treats the plural of the complete name as the same identity",
    line: { baseName: "San Marzano tomatoes" },
    catalog: { items: [{ id: "cat-tomato", name: "San Marzano tomato" }] },
    activations: {
      "cat-tomato": {
        id: "pantry-tomato",
        name: "San Marzano tomato",
        preparations: [],
      },
    },
  }),
  base({
    name: "links a synonym the catalog card answers to",
    line: { baseName: "confectioners sugar" },
    catalog: {
      items: [
        { id: "cat-caster", name: "Caster sugar", aliases: [] },
        {
          id: "cat-powdered",
          name: "Powdered sugar",
          preparations: [],
          aliases: ["confectioners sugar", "icing sugar"],
        },
      ],
    },
    activations: {
      "cat-powdered": {
        id: "pantry-powdered",
        name: "Powdered sugar",
        preparations: [],
      },
    },
  }),
  base({
    name: "does not replace a specific ingredient through a generic alias",
    line: {
      baseName: "lamb sirloin",
      identityCandidates: ["lamb sirloin", "sirloin"],
    },
    catalog: {
      items: [
        { id: "cat-sirloin", name: "Sirloin steak", aliases: ["sirloin"] },
      ],
    },
    activations: {
      "cat-sirloin": {
        id: "pantry-sirloin",
        name: "Sirloin steak",
        preparations: [],
      },
    },
  }),
  ...[
    ["Blood orange juice", "Orange juice"],
    ["Graffiti eggplant", "Eggplant"],
    ["San Marzano tomatoes", "Tomatoes"],
    ["Diamond Crystal kosher salt", "Kosher salt"],
  ].map(([written, generic]) =>
    base({
      name: `does not remove words from ${written} to reach ${generic}`,
      line: { baseName: written, identityCandidates: [written, generic] },
      ingredients: [],
      catalog: { items: [{ id: "cat-generic", name: generic, aliases: [] }] },
      activations: {
        "cat-generic": {
          id: "pantry-generic",
          name: generic,
          preparations: [],
        },
      },
    })
  ),
  base({
    name: "prefers the card named as written over one aliased to it",
    line: { baseName: "icing sugar" },
    catalog: {
      items: [
        { id: "cat-alias", name: "Powdered sugar", aliases: ["icing sugar"] },
        { id: "cat-name", name: "Icing sugar", aliases: [] },
      ],
    },
    activations: {
      "cat-name": { id: "pantry-icing", name: "Icing sugar", preparations: [] },
    },
  }),
  base({
    name: "still needs a pick for a fuzzy hit no synonym covers",
    line: { baseName: "powdened sugra" },
    catalog: {
      items: [
        {
          id: "cat-powdered",
          name: "Powdered sugar",
          aliases: ["confectioners sugar"],
        },
      ],
    },
  }),
  base({
    name: "leaves a name nothing answers unlinked",
    line: { baseName: "popo" },
    catalog: { items: [{ id: "cat-1", name: "Carrots" }] },
  }),
  base({
    name: "stays unlinked when the catalog copy fails",
    line: { baseName: "popo" },
    catalog: { items: [{ id: "cat-1", name: "Popo" }] },
  }),
  base({
    name: "never asks the catalog for a name the pantry answered",
    line: { baseName: "egg" },
  }),
  base({
    name: "does not infer a pantry row by removing a presumed brand",
    line: DIAMOND,
    ingredients: [{ id: "pantry-salt", name: "Kosher salt" }],
    recipes: [],
  }),
  base({
    name: "does not search the catalog again with a shortened name",
    line: DIAMOND,
    ingredients: [],
    recipes: [],
    catalog: {
      items: [],
      byQuery: { "kosher salt": [{ id: "cat-salt", name: "Kosher salt" }] },
    },
    activations: {
      "cat-salt": { id: "pantry-new", name: "Kosher salt", preparations: [] },
    },
  }),
  base({
    name: "matches the size word to a preparation under the bare name",
    line: {
      baseName: "large eggs",
      identityCandidates: ["egg"],
      sizeWord: "large",
    },
    ingredients: [{ id: "pantry-egg", name: "Egg", preparations: ["large"] }],
    recipes: [],
  }),
  base({
    name: "takes an exact catalog card over a generic pantry row",
    line: DIAMOND,
    ingredients: [{ id: "pantry-salt", name: "Salt" }],
    recipes: [],
    catalog: {
      items: [{ id: "cat-diamond", name: "Diamond Crystal kosher salt" }],
    },
    activations: {
      "cat-diamond": {
        id: "pantry-diamond",
        name: "Diamond Crystal kosher salt",
        preparations: [],
      },
    },
  }),
  base({
    name: "leaves the line open when only a generic pantry row exists",
    line: DIAMOND,
    ingredients: [{ id: "pantry-salt", name: "Salt" }],
    recipes: [],
  }),
  base({
    name: "keeps the size word as the note when no preparation carries it",
    line: {
      baseName: "large eggs",
      identityCandidates: ["egg"],
      sizeWord: "large",
    },
    ingredients: [{ id: "pantry-egg", name: "Egg" }],
    recipes: [],
  }),
  base({
    name: "does not infer a longer pantry identity from a generic name",
    line: { baseName: "sugar" },
    ingredients: [{ id: "pantry-granulated", name: "Granulated sugar" }],
    recipes: [],
  }),
  base({
    name: "leaves the line unlinked when two pantry rows could be meant",
    line: { baseName: "sugar" },
    ingredients: [
      { id: "pantry-granulated", name: "Granulated sugar" },
      { id: "pantry-brown", name: "Brown sugar" },
    ],
    recipes: [],
  }),
  base({
    name: "does not link salt to the only specific salt the cook stocks",
    line: { baseName: "salt" },
    ingredients: [
      { id: "pantry-kosher", name: "Kosher salt" },
      { id: "pantry-flour", name: "Bread flour" },
    ],
    recipes: [],
  }),
  base({
    name: "does not infer an active specific name after skipping an archived one",
    line: { baseName: "salt" },
    ingredients: [
      { id: "pantry-kosher", name: "Kosher salt" },
      { id: "pantry-sea", name: "Sea salt", status: "archived" },
    ],
    recipes: [],
  }),
  base({
    name: "never overrides the row the name was written as",
    line: { baseName: "sugar" },
    ingredients: [
      { id: "pantry-granulated", name: "Granulated sugar" },
      { id: "pantry-sugar", name: "Sugar" },
    ],
    recipes: [],
  }),
  // Beyond the suite.
  base({ name: "a blank name resolves to nothing", line: { baseName: "  " } }),
  base({
    name: "a one-letter name never reaches the catalog",
    line: { baseName: "x" },
    catalog: { items: [{ id: "cat-x", name: "X" }] },
    activations: { "cat-x": { id: "pantry-x", name: "X", preparations: [] } },
  }),
  base({
    name: "a size word finds its preparation on a catalog card",
    line: {
      baseName: "medium onions",
      identityCandidates: ["onion"],
      sizeWord: "medium",
    },
    ingredients: [],
    recipes: [],
    catalog: {
      items: [
        { id: "cat-onion", name: "Onion", preparations: ["small", "medium"] },
      ],
    },
    activations: {
      "cat-onion": {
        id: "pantry-onion",
        name: "Onion",
        preparations: ["small", "medium"],
      },
    },
  }),
  base({
    name: "a size-free identity asks the catalog a second time",
    line: {
      baseName: "large eggs",
      identityCandidates: ["egg"],
      sizeWord: "large",
    },
    ingredients: [],
    recipes: [],
    catalog: { items: [], byQuery: { egg: [{ id: "cat-egg", name: "Egg" }] } },
    activations: {
      "cat-egg": { id: "pantry-egg2", name: "Egg", preparations: [] },
    },
  }),
  base({
    name: "a note that already names the preparation keeps it once",
    line: {
      baseName: "large eggs",
      noteText: "Large, beaten",
      identityCandidates: ["egg"],
      sizeWord: "large",
    },
  }),
]

async function generate() {
  const cases = []
  for (const entry of CASES) {
    const searches: string[] = []
    const activated: string[] = []
    const resolved = await resolveLine(entry.line, {
      ingredients: entry.ingredients,
      recipes: entry.recipes,
      searchCatalog: async (query) => {
        searches.push(query)
        return { items: entry.catalog.byQuery?.[query] ?? entry.catalog.items }
      },
      activateCatalog: async (cardId) => {
        activated.push(cardId)
        return entry.activations[cardId] ?? { error: "no" }
      },
    })
    cases.push({
      ...entry,
      expect: resolved,
      calls: { searches, activations: activated },
    })
  }
  return { generator: GENERATOR, cases }
}

describe("the resolve-line fixture the Mac app asserts against", () => {
  it("matches what a written line links to", async () => {
    const generated = JSON.parse(JSON.stringify(await generate()))
    if (process.env.UPDATE_RESOLVE_LINE_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
