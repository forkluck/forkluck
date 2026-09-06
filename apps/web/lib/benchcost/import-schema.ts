import { z } from "zod"

export const costStepImportSchema = z.object({
  name: z.string().trim().min(1, "Step name is required").max(120),
  kind: z.enum(["active", "passive"]),
  covers: z.number().int().min(1, "covers must be at least 1"),
})

export const costRecipeImportSchema = z.object({
  name: z.string().trim().min(1, "Recipe name is required").max(120),
  ingredientCostPerBatch: z.number().min(0).default(0),
  batchYield: z.number().int().min(1, "batchYield must be at least 1"),
  sellableYield: z.number().int().min(1).nullable().optional().default(null),
  steps: z.array(costStepImportSchema).min(1, "At least one step is required"),
})

export type CostRecipeImport = z.infer<typeof costRecipeImportSchema>

export type ParsedImport =
  { ok: true; recipe: CostRecipeImport } | { ok: false; error: string }

export function parseCostRecipeImport(rawJson: string): ParsedImport {
  let data: unknown
  try {
    data = JSON.parse(rawJson)
  } catch {
    return {
      ok: false,
      error: "Not valid JSON — check for missing commas or quotes.",
    }
  }
  const result = costRecipeImportSchema.safeParse(data)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
    return { ok: false, error: `${path}${issue.message}` }
  }
  return { ok: true, recipe: result.data }
}
