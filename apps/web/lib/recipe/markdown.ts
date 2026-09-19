import { displayUnitShort } from "../unit-registry"
import {
  shownMeasure,
  shownQuantity,
  subrecipeBatchFactor,
  type MeasurableRecipeLine,
} from "./lines-for-tools"

/** The linked recipe a sub-recipe line expands into, one level deep. */
export type MarkdownSubrecipe = {
  title: string
  yieldAmount: number | null
  yieldUnit: string | null
  items: readonly MeasurableRecipeLine[]
}

export type MarkdownRecipeLine = MeasurableRecipeLine & {
  subrecipe?: MarkdownSubrecipe | null
}

/**
 * A recipe as a markdown document at the batch being viewed: its title as
 * the heading, its sections under that, "- 500 g bread flour, sifted" for a
 * measured line and "> chill overnight" for a note, the amounts formatted as
 * the sheet prints them. Each sub-recipe the lines call for follows as its
 * own section, spelled out at the amount this recipe uses, so the copy
 * stands on its own in a message or a doc. A row with no name is left out.
 */
export function recipeMarkdown(
  recipe: { title: string; items: readonly MarkdownRecipeLine[] },
  scale: number
): string {
  const title = recipe.title.trim()
  const blocks = linesMarkdown(
    recipe.items,
    scale,
    2,
    title ? [`# ${title}`] : []
  )

  // One section per sub-recipe, however many lines call for it: a child
  // asked for twice is one batch total.
  const children = new Map<MarkdownSubrecipe, number | null>()
  for (const item of recipe.items) {
    if (item.kind !== "subrecipe" || !item.subrecipe) continue
    const shown = shownMeasure(item, scale)
    const factor =
      shown.amount === null
        ? null
        : subrecipeBatchFactor(shown.amount, shown.unit, item.subrecipe)
    const sofar = children.get(item.subrecipe)
    children.set(
      item.subrecipe,
      factor === null || sofar === null ? null : (sofar ?? 0) + factor
    )
  }
  for (const [child, factor] of children) {
    const name = child.title.trim()
    if (!name) continue
    blocks.push(
      ...linesMarkdown(child.items, factor ?? 1, 3, [
        `## ${name}`,
        ...(factor === null ? ["> Amounts for one full batch"] : []),
      ])
    )
  }
  return blocks.join("\n\n")
}

/**
 * The lines as blocks, a blank line between them: the heading given in
 * `lead` sits over the lines that follow it, and each section heading in the
 * list starts a block of its own.
 */
function linesMarkdown(
  items: readonly MeasurableRecipeLine[],
  scale: number,
  headingLevel: number,
  lead: string[] = []
): string[] {
  const blocks: string[] = []
  let current: string[] = [...lead]
  const flush = () => {
    if (current.length) blocks.push(current.join("\n"))
    current = []
  }
  for (const item of items) {
    const name = item.displayName.trim()
    if (!name) continue
    if (item.kind === "header") {
      flush()
      current.push(`${"#".repeat(headingLevel)} ${name}`)
      continue
    }
    if (item.kind === "note") {
      current.push(`> ${name}`)
      continue
    }
    const shown = shownQuantity(item, scale)
    const note = item.preparationNote.trim()
    current.push(
      "- " +
        [
          shown.quantity,
          shown.quantity === null ? "" : displayUnitShort(shown.unit),
          note ? `${name}, ${note}` : name,
        ]
          .filter(Boolean)
          .join(" ")
    )
  }
  flush()
  return blocks
}
