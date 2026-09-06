import type { KitchenToolResult } from "@/lib/primo/kitchen-tool-results"
import type { KitchenToolName } from "@/lib/primo/kitchen-tools"

export const KITCHEN_TOOL_ACTION_LINES: Record<KitchenToolName, string> = {
  find_recipes: "Finding recipes…",
  find_products: "Finding products…",
  get_product_sales: "Reading sales…",
  show_recipe_batch: "Opening recipe…",
  get_recipe_cost_change: "Comparing costs…",
}

function cancelled() {
  return new DOMException("The tool call was cancelled.", "AbortError")
}

export async function executeKitchenTool(
  name: KitchenToolName,
  input: unknown,
  deps: {
    run: (name: KitchenToolName, input: unknown) => Promise<KitchenToolResult>
    navigate: (href: string) => Promise<void>
    showAction: (line: string) => void
  },
  signal: AbortSignal
): Promise<KitchenToolResult> {
  if (signal.aborted) throw cancelled()
  deps.showAction(KITCHEN_TOOL_ACTION_LINES[name])
  const result = await deps.run(name, input)
  if (signal.aborted) throw cancelled()
  if (result.ok && "view" in result) await deps.navigate(result.view)
  return result
}
