import type { KitchenToolResult } from "@/lib/kitchen-tools/results"
import type { KitchenToolName } from "@/lib/kitchen-tools/catalog"

export const KITCHEN_TOOL_ACTION_LINES: Record<KitchenToolName, string> = {
  find_recipes: "Finding recipes…",
  find_products: "Finding products…",
  get_product_sales: "Reading sales…",
  show_recipe_batch: "Opening recipe…",
  get_recipe: "Reading recipe…",
  get_recipe_cost_change: "Comparing costs…",
  calculate_batch_cost: "Calculating batch costs…",
  get_top_products: "Reading top products…",
  get_ingredient_price_changes: "Comparing ingredient prices…",
}

/**
 * Tools whose `view` is a link the reader may follow, not a screen the tool
 * opens. `get_recipe` answers in place: it has already returned every line, so
 * moving the browser would take the reader off the page they asked from.
 */
const READS_WITHOUT_NAVIGATING = new Set<KitchenToolName>(["get_recipe"])

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
  if (result.ok && "view" in result && !READS_WITHOUT_NAVIGATING.has(name))
    await deps.navigate(result.view)
  return result
}
