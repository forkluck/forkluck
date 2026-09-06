import { parseRecipeText } from "./parse"

/**
 * One pasted recipe, told apart: the list a cook shops from, and what they do
 * with it. A cook copies a whole page, so the paste box has to find the seam
 * itself rather than ask for two copies of the same paste.
 */
export type SplitRecipeDocument = {
  ingredients: string
  method: string
}

// A heading that hands the rest of the page to the method, written the way
// recipe sites write it: "Method", "## Directions", "How to make it:".
const METHOD_HEADING =
  /^#{0,6}\s*(?:method|directions?|instructions?|preparation|steps?|procedure|how to make(?:\s+it)?)\s*:?$/i
// The heading that hands it back, for a page that lists a second component
// after its method.
const INGREDIENTS_HEADING =
  /^#{0,6}\s*(?:ingredients?|you(?:'|’)?ll need|you will need|what you need)\s*:?$/i

/** Drops the blank lines at either end and keeps the rest as written. */
function joinLines(lines: string[]): string {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start += 1
  while (end > start && !lines[end - 1].trim()) end -= 1
  return lines.slice(start, end).join("\n")
}

/**
 * With no heading to go by, the method is the run of sentences the page ends
 * on: lines the ingredient parser never read as an ingredient, numbered steps
 * included. A single trailing sentence stays with the ingredients, because
 * "Chill overnight" under a list is a note about the list, and so does a
 * sentence between two ingredients.
 */
function splitTrailingProse(lines: string[]): SplitRecipeDocument {
  const parsed = parseRecipeText(lines.join("\n"))
  const prose = new Set(
    parsed.skippedLines
      .filter((line) => line.kind === "prose")
      .map((line) => line.lineNumber)
  )
  let start = lines.length
  let sentences = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) continue
    if (!prose.has(index + 1)) break
    start = index
    sentences += 1
  }
  const listedAbove = parsed.parsedLines.some(
    (line) => line.lineNumber <= start
  )
  if (sentences < 2 || !listedAbove) {
    return { ingredients: joinLines(lines), method: "" }
  }
  return {
    ingredients: joinLines(lines.slice(0, start)),
    method: joinLines(lines.slice(start)),
  }
}

/**
 * Read a whole pasted recipe as its two lists. A heading decides when there is
 * one; otherwise the sentences the page ends on are the method. Headings and
 * notes that belong to the list ("# Filling", "> chill overnight") stay with
 * the ingredients.
 */
export function splitRecipeDocument(text: string): SplitRecipeDocument {
  const lines = text.split(/\r?\n/)
  const ingredients: string[] = []
  const method: string[] = []
  let headed = false
  let target = ingredients
  for (const line of lines) {
    const trimmed = line.trim()
    if (METHOD_HEADING.test(trimmed)) {
      headed = true
      target = method
      continue
    }
    if (INGREDIENTS_HEADING.test(trimmed)) {
      headed = true
      target = ingredients
      continue
    }
    target.push(line)
  }
  if (!headed) return splitTrailingProse(lines)
  return { ingredients: joinLines(ingredients), method: joinLines(method) }
}
