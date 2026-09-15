import type { KitchenToolResult } from "@/lib/kitchen-tools/results"
import type { KitchenToolName } from "@/lib/kitchen-tools/catalog"

export const KITCHEN_TOOL_ACTION_LINES: Record<KitchenToolName, string> = {
  find_recipes: "Finding recipes…",
  find_products: "Finding products…",
  get_product_sales: "Reading sales…",
  show_recipe_batch: "Opening recipe…",
  get_recipe_cost_change: "Comparing costs…",
  calculate_batch_cost: "Calculating batch costs…",
  get_top_products: "Reading top products…",
  get_ingredient_price_changes: "Comparing ingredient prices…",
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
