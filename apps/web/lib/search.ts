import { normalizeIngredientName } from "@/lib/pricing"

/**
 * One matching and ranking rule for every search box, and the twin of
 * `apps/api/forkluck/domains/shared/search.py` — a stricter rule here would hide
 * rows the server just matched, since the palette re-filters what it fetched.
 *
 * Every token must be found, in any field and any order, so "maldon salt" finds
 * "Maldon Sea Salt". Ranking is Zulip's typeahead ladder, applied before any
 * list is truncated.
 */

/** Lower sorts first. */
export const SEARCH_RANK = {
  exact: 0,
  prefix: 1,
  wordStart: 2,
  contains: 3,
  noMatch: 4,
} as const

/** Matches the server's cap, which exists so one token is one AND clause. */
const MAX_TOKENS = 12

/** Folded like `normalized_name`. An empty list means no search. */
export function searchTokens(query: string): string[] {
  const folded = normalizeIngredientName(query)
  return folded ? folded.split(" ").slice(0, MAX_TOKENS) : []
}

/** True when every token appears in at least one of the fields. */
export function matchesTokens(fields: string[], tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const folded = fields.map((field) => normalizeIngredientName(field))
  return tokens.every((token) => folded.some((field) => field.includes(token)))
}

/** Scored on the row's best field, so an exact SKU beats a loose name. */
export function searchRank(fields: string[], tokens: string[]): number {
  if (tokens.length === 0) return SEARCH_RANK.noMatch
  const needle = tokens.join(" ")
  let best: number = SEARCH_RANK.noMatch
  for (const field of fields) {
    const folded = normalizeIngredientName(field)
    if (!folded) continue
    const rank =
      folded === needle
        ? SEARCH_RANK.exact
        : folded.startsWith(needle)
          ? SEARCH_RANK.prefix
          : folded.includes(` ${needle}`)
            ? SEARCH_RANK.wordStart
            : folded.includes(needle)
              ? SEARCH_RANK.contains
              : // No field holds a multi-token query adjacently, so fall
                // back to the first token.
                tokens.length > 1
                ? folded.startsWith(tokens[0])
                  ? SEARCH_RANK.wordStart
                  : SEARCH_RANK.contains
                : SEARCH_RANK.noMatch
    if (rank < best) best = rank
  }
  return best
}

/**
 * What matches, best first — before the caller slices. Ties keep their incoming
 * order, which for a server-sent list is the server's own ranking.
 */
/**
 * Rank without dropping. The server searched fields the browser never receives
 * — supplier titles, recipe public ids — so filtering again here would hide
 * rows it deliberately returned.
 */
export function rankedServerResults<T>(
  items: readonly T[],
  fields: (item: T) => string[],
  query: string
): T[] {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return [...items]
  return items
    .map((item, index) => ({
      item,
      rank: searchRank(fields(item), tokens),
      index,
    }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.item)
}

export function rankedMatches<T>(
  items: readonly T[],
  fields: (item: T) => string[],
  query: string
): T[] {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return [...items]
  const scored: Array<{ item: T; rank: number; index: number }> = []
  items.forEach((item, index) => {
    const itemFields = fields(item)
    if (!matchesTokens(itemFields, tokens)) return
    scored.push({ item, rank: searchRank(itemFields, tokens), index })
  })
  scored.sort(
    (left, right) => left.rank - right.rank || left.index - right.index
  )
  return scored.map((entry) => entry.item)
}

/**
 * The pantry pickers' predicate. `ingredient_search` on the server also reaches
 * alternate names and supplier titles; the browser only has the name.
 */
export function matchesIngredientSearch(
  entry: { normalizedName: string },
  query: string
): boolean {
  return matchesTokens([entry.normalizedName], searchTokens(query))
}

/** The same rule for a list that gets shown. */
export function rankedIngredientMatches<T extends { normalizedName: string }>(
  entries: readonly T[],
  query: string
): T[] {
  return rankedMatches(entries, (entry) => [entry.normalizedName], query)
}
