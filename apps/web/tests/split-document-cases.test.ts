import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { splitRecipeDocument } from "@/lib/recipe/split-document"

/**
 * A pasted page split into its ingredient list and its method, pinned as data.
 *
 * `tests/fixtures/split-document-cases.json` is copied verbatim into the Mac
 * app (`forkluck-macosTests/Fixtures/`), whose Swift port of
 * splitRecipeDocument asserts every case. Regenerate with
 * `UPDATE_SPLIT_DOCUMENT_FIXTURE=1 pnpm exec vitest run tests/split-document-cases.test.ts`
 * and copy it across.
 */

const FIXTURE = new URL("./fixtures/split-document-cases.json", import.meta.url)
const GENERATOR =
  "cd apps/web && UPDATE_SPLIT_DOCUMENT_FIXTURE=1 pnpm exec vitest run tests/split-document-cases.test.ts"

// The documents of recipe-split-document.test.ts.
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

const DOCUMENTS = [
  HEADED,
  BARE,
  "500 g flour\n10 g salt\n1. Whisk the eggs.\n2. Fold in the flour.",
  "Ingredients\n500 g flour\nMethod\nMix it well.\nBake it.\n# Ingredients\n200 g sugar",
  "500 g flour\nUse the good flour here.\n10 g salt",
  "500 g flour\n10 g salt\nChill overnight.",
  "Some thoughts about a recipe.\nAnd another line of them.",
  // Beyond the suite: other headings, Windows line ends, blank input.
  "INGREDIENTS:\n2 cups flour\n1 tsp salt\n\nDIRECTIONS:\nMix.\nBake at 350F for 20 minutes.",
  "## Instructions\nStir well.\nServe warm.",
  "2 eggs\r\n100 g sugar\r\nWhisk the eggs and sugar until pale.\r\nFold in the flour gently.",
  "Steps\n1) Mix\n2) Bake",
  "How to make it\nMix everything together.",
  "",
  "   \n  \n",
  "500 g flour\n10 g salt\nKnead for ten minutes until smooth.\nRest the dough for an hour.",
  "Preparation:\n1 onion\n2 carrots",
]

function generate() {
  return {
    generator: GENERATOR,
    cases: DOCUMENTS.map((text) => ({
      text,
      expect: splitRecipeDocument(text),
    })),
  }
}

describe("the split-document fixture the Mac app asserts against", () => {
  it("matches how a pasted page is split", () => {
    const generated = JSON.parse(JSON.stringify(generate()))
    if (process.env.UPDATE_SPLIT_DOCUMENT_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
