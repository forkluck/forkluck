import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { fuzzyMatches } from "@/lib/fuzzy"
import {
  centsToDollarInput,
  dollarsToCents,
  formatCents,
  formatPreciseCents,
  formatWholeCents,
} from "@/lib/money"
import { matchPreparation, normalizeIngredientName } from "@/lib/pricing"
import { lineIdentity, withPreparationNote } from "@/lib/recipe/resolve-line"
import { matchesTokens, searchRank, searchTokens } from "@/lib/search"

/**
 * Names, typo tolerance and money as the web spells them, pinned as data.
 *
 * `tests/fixtures/text-cases.json` is copied verbatim into the Mac app
 * (`forkluck-macosTests/Fixtures/`), whose Swift ports assert every case.
 * Regenerate with
 * `UPDATE_TEXT_FIXTURE=1 pnpm exec vitest run tests/text-cases.test.ts` and
 * copy it across.
 */

const FIXTURE = new URL("./fixtures/text-cases.json", import.meta.url)
const GENERATOR =
  "cd apps/web && UPDATE_TEXT_FIXTURE=1 pnpm exec vitest run tests/text-cases.test.ts"

/** pricing.test.ts and test_name_normalization.py, then accents and marks. */
const NAMES = [
  "  Bread Flour ",
  "P. Sugar",
  "Extra-Virgin  Olive Oil",
  "Crème Fraîche",
  "Creme Fraiche",
  "Jalapeño",
  "püree",
  "  Crème---fraîche! ",
  "ICING SUGAR",
  "Pimentón de la Vera",
  "Açaí",
  "Straße",
  "Œufs",
  "Ñoquis",
  "Häagen-Dazs",
  "Piment d'Espelette",
  "Chef's 00 flour",
  "1/2 & 1/2",
  "Salt_and_pepper",
  "Tomatoes (San Marzano)",
  "large, room temperature",
  "Diced; 2 cm",
  "  ",
  "",
  "日本酒",
  "Café́",
  "ﬁne salt",
  "Ｆｕｌｌ width",
  "éclair",
]

/** resolve-line.test.ts names, then the plural rules one at a time. */
const IDENTITIES = [
  "eggs",
  "Egg",
  "large eggs",
  "San Marzano tomatoes",
  "San Marzano tomato",
  "Lemon Curd",
  "berries",
  "cherries",
  "keys",
  "potatoes",
  "peaches",
  "radishes",
  "boxes",
  "chives",
  "molasses",
  "asparagus",
  "hummus",
  "couscous",
  "anise",
  "gas",
  "us",
  "is",
  "leaves",
  "  ",
  "Crème Fraîches",
]

/** withPreparationNote cases from resolve-line.test.ts, then edges. */
const NOTES: { existing: string; preparation: string | null }[] = [
  { existing: "2 ounces; 56 g", preparation: "large" },
  { existing: "softened", preparation: null },
  { existing: "Diced, 2 cm", preparation: "diced" },
  { existing: "", preparation: "large" },
  { existing: "  ", preparation: "large" },
  { existing: "beaten", preparation: "  " },
  { existing: "Large; beaten", preparation: "large" },
  { existing: "cold", preparation: " sifted " },
]

/** A preparation matches a whole clause of the note, never a part of one. */
const PREPARATIONS = ["beaten", "large", "room temperature", "Sifted", "yolks"]
const QUALIFIERS = [
  null,
  "",
  "beaten",
  "large, 2 ounces; 56 g",
  "room temperature",
  "large, room temperature",
  "SIFTED",
  "sifted twice",
  "separated; yolks",
  " , ; ",
  "Room-temperature",
]

/** fuzzy.test.ts, on folded text as the search hands it over. */
const FUZZY: { text: string; query: string }[] = [
  { text: "garlic", query: "jarlic" },
  { text: "garlic", query: "garlc" },
  { text: "black garlic", query: "garlik" },
  { text: "garlic", query: "ga" },
  { text: "garlic", query: "ge" },
  { text: "garlic powder", query: "garl pow" },
  { text: "garlic", query: "carrot" },
  { text: "egg", query: "popo" },
  { text: "powdered sugar", query: "powdened sugra" },
  { text: "confectioners sugar", query: "confectoners" },
  { text: "all purpose flour", query: "all purpse flur" },
  { text: "onion", query: "onoin" },
  { text: "onion", query: "oni" },
  { text: "cinnamon", query: "cinamon" },
  { text: "cinnamon", query: "cinnamin sticks" },
  { text: "worcestershire sauce", query: "worchestershire" },
  { text: "worcestershire sauce", query: "worcesterhsire" },
  { text: "", query: "" },
  { text: "salt", query: "" },
  { text: "salt", query: "  " },
]

/** money.test.ts, then the halves JS rounds up and a few currencies. */
const CENTS: { cents: number; currency?: string }[] = [
  { cents: 2450 },
  { cents: 3750 },
  { cents: 3.4 },
  { cents: 2450, currency: "EUR" },
  { cents: 100, currency: "JPY" },
  { cents: 287.5 },
  { cents: 288 },
  { cents: 0.018 },
  { cents: 287.5, currency: "KWD" },
  { cents: 287.5, currency: "US$" },
  { cents: 390_540 },
  { cents: 390_560 },
  { cents: 100, currency: "US$" },
  { cents: 0 },
  { cents: 0.5 },
  { cents: 1.5 },
  { cents: 2.5 },
  { cents: -0.5 },
  { cents: -1.5 },
  { cents: -250 },
  { cents: 49.5 },
  { cents: 123_456_789 },
  { cents: 1 / 3 },
  { cents: 2450, currency: "GBP" },
  { cents: 2450, currency: "CAD" },
  { cents: 2450, currency: "CHF" },
]

const TYPED = [
  "24.50",
  "$3.46",
  " $3.46 ",
  "1,234.56",
  "$1,234.56",
  ".5",
  "3.",
  "",
  "-3",
  "3.46abc",
  "abc",
  "$",
  ".",
  "1.2.3",
  "$-3",
  "0.005",
  "0.015",
  "1.005",
  "2.675",
  "10",
  "1 000",
  "0",
]

const STORED = [2450, 346, 0, 5, 123456, 99.5]

/** Search inputs: a query against the fields of one row. */
const SEARCHES: { fields: string[]; query: string }[] = [
  { fields: ["Maldon Sea Salt"], query: "maldon salt" },
  { fields: ["Salt"], query: "salt" },
  { fields: ["Salted butter"], query: "salt" },
  { fields: ["Kosher salt"], query: "salt" },
  { fields: ["Unsalted butter"], query: "salt" },
  { fields: ["Bread flour", "flour"], query: "flo" },
  { fields: ["Crème fraîche"], query: "creme" },
  { fields: ["Lemon juice"], query: "juice lemon" },
  { fields: ["Lemon juice"], query: "lemon zest" },
  { fields: ["Egg"], query: "" },
]

function generate() {
  return {
    generator: GENERATOR,
    normalizedName: NAMES.map((input) => ({
      input,
      expect: normalizeIngredientName(input),
    })),
    lineIdentity: IDENTITIES.map((input) => ({
      input,
      expect: lineIdentity(input),
    })),
    withPreparationNote: NOTES.map((note) => ({
      ...note,
      expect: withPreparationNote(note.existing, note.preparation),
    })),
    matchPreparation: QUALIFIERS.map((qualifier) => ({
      preparations: PREPARATIONS,
      qualifier,
      expect:
        matchPreparation(
          { preparations: PREPARATIONS.map((name) => ({ name })) },
          qualifier
        )?.name ?? null,
    })),
    fuzzyMatches: FUZZY.map((pair) => ({
      ...pair,
      expect: fuzzyMatches(pair.text, pair.query),
    })),
    formatCents: CENTS.map(({ cents, currency }) => ({
      cents,
      currency: currency ?? "USD",
      expect: formatCents(cents, currency),
    })),
    formatWholeCents: CENTS.map(({ cents, currency }) => ({
      cents,
      currency: currency ?? "USD",
      expect: formatWholeCents(cents, currency),
    })),
    formatPreciseCents: CENTS.map(({ cents, currency }) => ({
      cents,
      currency: currency ?? "USD",
      expect: formatPreciseCents(cents, currency),
    })),
    dollarsToCents: TYPED.map((input) => ({
      input,
      expect: dollarsToCents(input),
    })),
    centsToDollarInput: STORED.map((cents) => ({
      cents,
      expect: centsToDollarInput(cents),
    })),
    search: SEARCHES.map(({ fields, query }) => {
      const tokens = searchTokens(query)
      return {
        fields,
        query,
        tokens,
        matches: matchesTokens(fields, tokens),
        rank: searchRank(fields, tokens),
      }
    }),
  }
}

describe("the text fixture the Mac app asserts against", () => {
  it("matches how the web folds names and prints money", () => {
    const generated = JSON.parse(JSON.stringify(generate()))
    if (process.env.UPDATE_TEXT_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
