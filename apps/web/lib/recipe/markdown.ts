import { displayUnitShort } from "../unit-registry"
import { shownQuantity, type MeasurableRecipeLine } from "./lines-for-tools"

/**
 * A recipe's lines as a markdown list at the batch being viewed, in the
 * notation the paste importer reads back: "# Filling" opens a section,
 * "> chill overnight" is a note, and a measured line is "- 500 g bread flour,
 * sifted", the amount formatted as the sheet prints it. What is copied out
 * pastes back in as the same rows. A row with no name has nothing to say and
 * is left out.
 */
export function recipeLinesMarkdown(
  items: readonly MeasurableRecipeLine[],
  scale: number
): string {
  const lines: string[] = []
  for (const item of items) {
    const name = item.displayName.trim()
    if (!name) continue
    if (item.kind === "header") {
      lines.push(`# ${name}`)
      continue
    }
    if (item.kind === "note") {
      lines.push(`> ${name}`)
      continue
    }
    const shown = shownQuantity(item, scale)
    const note = item.preparationNote.trim()
    lines.push(
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
  return lines.join("\n")
}
