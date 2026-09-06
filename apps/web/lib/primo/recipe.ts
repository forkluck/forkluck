import { z } from "zod"
import type { ToolCallRepairFunction, ToolSet } from "ai"

import { UNIT_CATALOG, YIELD_UNIT_VALUES } from "@/lib/unit-registry"

const recipeLineUnits = UNIT_CATALOG.map((unit) => unit.slug) as [
  string,
  ...string[],
]

export const primoRecipeDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).default(""),
  yield: z
    .strictObject({
      amount: z.number().positive().max(1_000_000),
      unit: z.enum(YIELD_UNIT_VALUES),
    })
    .nullable()
    .default(null)
    .describe(
      'Recipe yield as an object, e.g. {"amount": 10, "unit": "pcs"} for 10 servings or {"amount": 4, "unit": "qt"} for 4 quarts. Never a string. Null only when unstated.'
    ),
  ingredients: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        quantity: z.number().positive().max(1_000_000).nullable(),
        unit: z.union([z.enum(recipeLineUnits), z.literal("")]),
        preparation: z.string().trim().max(200).default(""),
      })
    )
    .min(1)
    .max(100),
  steps: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
})

export type PrimoRecipeDraft = z.infer<typeof primoRecipeDraftSchema>

/** Qwen can double-encode the nullable yield object. Decode only that wire
 * representation, never infer a quantity/unit, and validate the whole draft. */
export const repairPrimoRecipeToolCall: ToolCallRepairFunction<
  ToolSet
> = async ({ toolCall }) => {
  if (toolCall.toolName !== "draft_recipe") return null
  try {
    const input = JSON.parse(toolCall.input)
    if (typeof input.yield !== "string") return null
    const parsed = primoRecipeDraftSchema.safeParse({
      ...input,
      yield: JSON.parse(input.yield),
    })
    return parsed.success
      ? { ...toolCall, input: JSON.stringify(parsed.data) }
      : null
  } catch {
    return null
  }
}
