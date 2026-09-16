import { precisionFor } from "../precise-ingredients"
import { displayUnitShort } from "../unit-registry"
import { clampRecipeQuantity, formatMeasuredAmount, tidyVolume } from "./scale"

/** A recipe line as a source of measurement, whatever record it came from:
 * the owner's saved recipe or the read-only guest shape. */
export type MeasurableRecipeLine = {
  kind: "header" | "note" | "ingredient" | "subrecipe"
  displayName: string
  quantity: number | null
  unit: string
  preparationNote: string
}

/**
 * What a line shows at the batch being viewed: its own quantity and unit at
 * 1x, otherwise the scaled amount in the unit a cook would measure it with.
 * The same rule the editor's table applies, read-only.
 */
export function shownMeasure(
  line: Pick<MeasurableRecipeLine, "quantity" | "unit">,
  scale: number
): { amount: number | null; unit: string } {
  if (line.quantity === null) return { amount: null, unit: line.unit }
  if (scale === 1) return { amount: line.quantity, unit: line.unit }
  const tidy = tidyVolume(line.quantity * scale, line.unit)
  return {
    amount: Number(clampRecipeQuantity(tidy.amount)),
    unit: tidy.unit,
  }
}

/** The quantity column as the sheet prints it: the scaled amount at the
 * ingredient's own precision, without its unit. */
export function shownQuantity(
  line: Pick<MeasurableRecipeLine, "quantity" | "unit" | "displayName">,
  scale: number
): { quantity: string | null; unit: string } {
  const measure = shownMeasure(line, scale)
  return {
    quantity:
      measure.amount === null
        ? null
        : formatMeasuredAmount(
            measure.amount,
            measure.unit,
            precisionFor(line.displayName)
          ),
    unit: measure.unit,
  }
}

/** One recipe line as a tool result carries it: the numbers already read off
 * the sheet, formatted here once and by the guest recipe sheet, so a chat
 * answer and that sheet round a batch the same way. The owner's editor table
 * and Cost tab round some units to a precision of their own, so a quantity
 * there can be rounder than the one quoted in chat. */
export type RecipeToolLine = {
  kind: "ingredient" | "recipe" | "note"
  name: string
  quantity: string | null
  unit: string | null
  note: string | null
}

/** Beyond this the list is a document, not an answer; the caller opens the
 * recipe instead. */
export const RECIPE_TOOL_LINE_LIMIT = 80

export type RecipeToolLines = {
  lines: RecipeToolLine[]
  lineCount: number
  truncated: boolean
}

/**
 * Every line of one recipe at one batch, in recipe order, formatted exactly as
 * the sheet formats it. Headers and notes carry no measurement, so they arrive
 * as `note` lines; a sub-recipe line keeps its own quantity and unit rather
 * than expanding into the child's formula.
 */
export function recipeLinesForTools(
  items: readonly MeasurableRecipeLine[],
  scale: number
): RecipeToolLines {
  const lines = items.map((item): RecipeToolLine => {
    if (item.kind === "header" || item.kind === "note") {
      return {
        kind: "note",
        name: item.displayName,
        quantity: null,
        unit: null,
        note: item.preparationNote || null,
      }
    }
    const shown = shownQuantity(item, scale)
    return {
      kind: item.kind === "subrecipe" ? "recipe" : "ingredient",
      name: item.displayName,
      quantity: shown.quantity,
      unit: displayUnitShort(shown.unit) || null,
      note: item.preparationNote || null,
    }
  })
  return {
    lines: lines.slice(0, RECIPE_TOOL_LINE_LIMIT),
    lineCount: lines.length,
    truncated: lines.length > RECIPE_TOOL_LINE_LIMIT,
  }
}
