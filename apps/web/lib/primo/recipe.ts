import type { ToolCallRepairFunction, ToolSet } from "ai"

import { recipeDraftSchema } from "@/lib/recipe/draft"

/** Qwen can double-encode the nullable yield object. Decode only that wire
 * representation, never infer a quantity/unit, and validate the whole draft. */
export const repairPrimoRecipeToolCall: ToolCallRepairFunction<
  ToolSet
> = async ({ toolCall }) => {
  if (toolCall.toolName !== "draft_recipe") return null
  try {
    const input = JSON.parse(toolCall.input)
    if (typeof input.yield !== "string") return null
    const parsed = recipeDraftSchema.safeParse({
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
