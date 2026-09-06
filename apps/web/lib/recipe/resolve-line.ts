import { normalizeIngredientName } from "../pricing"

/** A pantry row a line can link to, with the preparations saved under it. */
export type ResolveIngredientTarget = {
  id: string
  name: string
  preparations?: string[]
  /** Absent where the caller has no status to give; archived rows are skipped. */
  status?: "active" | "archived"
}

export type ResolveRecipeTarget = {
  id: string
  /** What a link to the recipe is written with; absent before it is read. */
  publicId?: string | null
  title: string
}

/** The catalog card the search hands back. */
export type ResolveCatalogRow = {
  id: string
  name: string
  preparations?: string[]
  /** The card's synonyms: "confectioners sugar" is Powdered sugar. */
  aliases?: string[]
}

/**
 * The fields a resolver reads off a parsed line. `noteText` is the annotations
 * as written and `qualifier` the normalized one; a line that carries neither
 * simply has no note yet.
 */
export type ResolvableLine = {
  /** What the row is called, size words kept: "large eggs". */
  baseName: string
  qualifier?: string | null
  noteText?: string | null
  /**
   * The parsed spelling without a structured size word: "large eggs" is
   * "eggs". Arbitrary words are never removed to produce another identity.
   */
  identityCandidates?: string[]
  /** The size the piece was written in: "large" of "3 large eggs". */
  sizeWord?: string | null
}

export type ResolvedLinePatch = {
  kind: "ingredient" | "subrecipe"
  ingredientId: string | null
  subrecipeId: string | null
  subrecipePublicId: string | null
  displayName: string
  preparationNote: string
}

export type ResolvedLine = {
  patch: ResolvedLinePatch
  /** A catalog card copied into the pantry, so later lines can see it. */
  activated: ResolveIngredientTarget | null
}

export type ResolveLineSources = {
  ingredients: ResolveIngredientTarget[]
  recipes: ResolveRecipeTarget[]
  searchCatalog: (
    query: string
  ) => Promise<{ items: ResolveCatalogRow[] } | { error: string }>
  activateCatalog: (
    catalogIngredientId: string
  ) => Promise<
    { id: string; name: string; preparations: string[] } | { error: string }
  >
}

/**
 * A cook writes "eggs" and stocks "Egg". Folding the last word is enough for
 * the plurals a recipe actually writes; nothing here tries to be a stemmer.
 */
function singular(word: string): string {
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`
  if (/(?:o|ch|sh|x|z)es$/.test(word)) return word.slice(0, -2)
  if (/(?:ss|us|is)$/.test(word)) return word
  if (word.length > 2 && /s$/.test(word)) return word.slice(0, -1)
  return word
}

/** The identity two names are compared on: folded, and plural-tolerant. */
export function lineIdentity(name: string): string {
  const words = normalizeIngredientName(name).split(" ").filter(Boolean)
  if (!words.length) return ""
  words[words.length - 1] = singular(words[words.length - 1])
  return words.join(" ")
}

function sameIdentity(left: string, right: string): boolean {
  const identity = lineIdentity(left)
  return identity !== "" && identity === lineIdentity(right)
}

/**
 * The note a picked row leaves behind: whatever the line already said, with
 * the preparation in front of it: "large, 2 ounces; 56 g". A preparation the
 * note already names is not repeated.
 */
export function withPreparationNote(
  existing: string,
  preparation: string | null | undefined
): string {
  const note = existing.trim()
  const word = (preparation ?? "").trim()
  if (!word) return existing
  if (!note) return word
  const already = note
    .split(/[,;]/)
    .some(
      (part) => normalizeIngredientName(part) === normalizeIngredientName(word)
    )
  return already ? existing : `${word}, ${note}`
}

/**
 * A row stocked under one of the line's names whose preparations include the
 * size the line was written in: "3 large eggs" against Egg with "large".
 */
function sizedMatch(
  row: { name: string; preparations?: string[] },
  names: string[],
  sizeWord: string | null | undefined
): string | null {
  const size = (sizeWord ?? "").trim().toLocaleLowerCase()
  if (!size) return null
  if (!names.some((candidate) => sameIdentity(row.name, candidate))) return null
  return (
    (row.preparations ?? []).find(
      (preparation) => preparation.trim().toLocaleLowerCase() === size
    ) ?? null
  )
}

function ingredientPatch(
  id: string,
  displayName: string,
  note: string,
  preparation: string | null
): ResolvedLinePatch {
  return {
    kind: "ingredient",
    ingredientId: id,
    subrecipeId: null,
    subrecipePublicId: null,
    displayName,
    preparationNote: withPreparationNote(note, preparation),
  }
}

/**
 * What a written ingredient line links to, in the order a chef would expect:
 * their own pantry first, then their own recipes, then the open catalog. A
 * name none of those answer stays as typed, which the table flags in amber.
 *
 * The catalog is asked for the written name. A structured size word may also
 * expose the exact underlying identity, but arbitrary name words are kept.
 */
export async function resolveLine(
  parsed: ResolvableLine,
  sources: ResolveLineSources
): Promise<ResolvedLine | null> {
  const name = parsed.baseName.trim()
  if (!name) return null
  const note = parsed.noteText ?? parsed.qualifier ?? ""
  // The written name comes first. Only a structured size word may expose a
  // second identity: arbitrary descriptors and brand words remain meaningful.
  const parsedNames = parsed.identityCandidates ?? []
  const names = [name, parsed.sizeWord ? parsedNames[0] : null].filter(
    (candidate): candidate is string => candidate !== null
  )
  const distinctNames = names.filter(
    (candidate, index, all) =>
      candidate.trim() !== "" &&
      all.findIndex((other) => sameIdentity(other, candidate)) === index
  )
  // An archived ingredient is still priced and still linked wherever a recipe
  // already names it; it just stops answering new lines.
  const pantry = sources.ingredients.filter((one) => one.status !== "archived")
  const stocked = (candidate: string) =>
    pantry.find((one) => sameIdentity(one.name, candidate))
  // A size word with no preparation to land on still belongs on the line:
  // "3 large eggs" against a plain Egg keeps "large" as its note.
  const size = parsed.sizeWord?.trim() || null
  const linked = (
    row: { id: string; name: string },
    preparation: string | null
  ): ResolvedLine => ({
    patch: ingredientPatch(row.id, row.name, note, preparation ?? size),
    activated: null,
  })

  // The name as written wins outright; a size word then looks for its
  // preparation before the structured size-free identity gets to answer.
  const written = stocked(name)
  if (written) return linked(written, null)

  for (const one of pantry) {
    const preparation = sizedMatch(one, distinctNames, parsed.sizeWord)
    if (preparation) return linked(one, preparation)
  }

  const recipe = sources.recipes.find(
    (one) =>
      normalizeIngredientName(one.title) === normalizeIngredientName(name)
  )
  if (recipe) {
    return {
      patch: {
        kind: "subrecipe",
        ingredientId: null,
        subrecipeId: recipe.id,
        subrecipePublicId: recipe.publicId ?? null,
        displayName: recipe.title,
        preparationNote: note,
      },
      activated: null,
    }
  }

  // The catalog answers to the most specific reading it has: the complete
  // written name beats the structured size-free identity.
  const bestCard = (
    items: ResolveCatalogRow[]
  ): { card: ResolveCatalogRow; preparation: string | null } | null => {
    for (const candidate of distinctNames) {
      const exact = items.find((one) => sameIdentity(one.name, candidate))
      if (exact) return { card: exact, preparation: null }
    }
    // A synonym the card answers to is the card: the line wrote the same
    // ingredient under another name, which is not a guess to hand back.
    // An explicit alias must answer the complete name as written.
    for (const candidate of [name]) {
      const synonym = items.find((one) =>
        (one.aliases ?? []).some((alias) => sameIdentity(alias, candidate))
      )
      if (synonym) return { card: synonym, preparation: null }
    }
    const sized = items
      .map((one) => ({
        card: one,
        preparation: sizedMatch(one, distinctNames, parsed.sizeWord),
      }))
      .find((row) => row.preparation !== null)
    return sized ?? null
  }

  // The backend also matches typos, and a fuzzy hit reads no differently
  // from an exact one here: only a name or a synonym that reads as one of the
  // line's own is taken, and everything else waits for a pick. Asked with the
  // The full name is searched first. A structured size-free identity may be
  // searched once more; no arbitrary word removal produces another query.
  const queries = distinctNames.slice(0, 2).filter((one) => one.length >= 2)
  let card: ResolveCatalogRow | null = null
  let preparation: string | null = null
  for (const [index, query] of queries.entries()) {
    if (index === 1) {
      for (const candidate of distinctNames.slice(1)) {
        const owned = stocked(candidate)
        if (owned) return linked(owned, null)
      }
    }
    const found = await sources.searchCatalog(query)
    if ("error" in found) return null
    const best = bestCard(found.items)
    if (best) {
      card = best.card
      preparation = best.preparation
      break
    }
  }
  if (!card) {
    for (const candidate of distinctNames.slice(1)) {
      const owned = stocked(candidate)
      if (owned) return linked(owned, null)
    }
  }
  if (!card) return null

  const activated = await sources.activateCatalog(card.id)
  if ("error" in activated) return null
  return {
    patch: ingredientPatch(activated.id, activated.name, note, preparation),
    activated: {
      id: activated.id,
      name: activated.name,
      preparations: activated.preparations,
    },
  }
}
