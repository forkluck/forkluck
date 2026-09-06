/**
 * Typo tolerance for a name search, the same rule the catalog search applies
 * in Python (`domains/shared/fuzzy.py`): every typed word must appear in the
 * name, or sit within a small edit distance of a word — or the start of a
 * word — in it. "jarlic" finds garlic; "ga" still only prefixes.
 */

/** Edits allowed for a word this long: none under four letters. */
function allowance(length: number): number {
  return length < 4 ? 0 : length < 8 ? 1 : 2
}

/** Levenshtein distance, bounded so it can stop early. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      )
      current.push(value)
      if (value < best) best = value
    }
    if (best > limit) return limit + 1
    previous = current
  }
  return previous[b.length]
}

/** Whether `token` is close enough to `word` or to the start of it. */
function near(token: string, word: string): boolean {
  const limit = allowance(token.length)
  if (limit === 0) return word.startsWith(token)
  if (distance(token, word, limit) <= limit) return true
  return (
    word.length > token.length &&
    distance(token, word.slice(0, token.length), limit) <= limit
  )
}

/** Every word of the folded `query` matches a word of the folded `text`. */
export function fuzzyMatches(text: string, query: string): boolean {
  const words = text.split(" ").filter(Boolean)
  return query
    .split(" ")
    .filter(Boolean)
    .every(
      (token) => text.includes(token) || words.some((word) => near(token, word))
    )
}
