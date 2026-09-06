import type { ExpansionIssue } from "@/lib/backend/types"

/**
 * Why a product has no cost, in the merchant's words.
 *
 * A product without a cost used to read "Add a recipe to cost this product"
 * whatever the reason, which is right exactly once — when there is no
 * composition at all — and misleading every other time. Each sentence here
 * names the one thing to go and fix.
 *
 * The codes come from `ExpansionIssue` in the shared physical-expansion
 * contract, so a code minted there and never given copy here still shows the
 * fallback rather than an empty alert.
 */
const ISSUE_MESSAGES: Record<string, string> = {
  "no-composition": "Add a recipe or an ingredient to cost this product",
  "missing-ingredient-price": "No price yet",
  "unresolved-ingredient": "Not in your ingredients",
  "unresolved-recipe": "Recipe is no longer available",
  "unresolved-component": "This line points at nothing",
  "unresolved-line": "This line points at nothing",
  "recipe-cycle": "This recipe contains itself",
  "product-cycle": "This product contains itself",
  "unresolved-product": "A product inside this one could not be found",
  "missing-quantity": "No quantity",
  "missing-purchase-size": "No purchase size on the ingredient",
  "missing-purchase-unit": "No purchase unit on the ingredient",
  "unresolved-purchase-unit": "Bought in a unit this line does not use",
  "unresolved-conversion": "Not a measurement of this ingredient",
  "missing-yield": "The recipe does not say what it makes",
  "unresolved-yield": "The recipe's yield cannot be measured",
  "unresolved-yield-unit": "The recipe's yield unit is not a measurement",
  "invalid-yield": "The recipe's yield is not a usable number",
  "invalid-efficiency": "A line's efficiency is not a usable number",
  "non-finite-result": "The numbers do not resolve to a usable amount",
  "missing-recipe": "Recipe is no longer available",
}

const FALLBACK = "This cannot be costed yet"

/** The sentence for one issue, without the row it happened on. */
export function costIssueMessage(issue: ExpansionIssue): string {
  return ISSUE_MESSAGES[issue.code] ?? FALLBACK
}

/**
 * One issue as a whole line: what is wrong, and where.
 *
 * `path` arrives outermost-first — the recipe, then the ingredient inside it —
 * which is the order a person would go looking.
 */
export function costIssueLine(issue: ExpansionIssue): string {
  const where = issue.path.filter(Boolean).join(" · ")
  const message = costIssueMessage(issue)
  return where ? `${where} — ${message}` : message
}

/**
 * The note beside the Cost metric. One issue speaks for itself; several are
 * counted, because a metric card is not the place to list them.
 */
export function costIssueSummary(
  issues: readonly ExpansionIssue[]
): string | null {
  if (issues.length === 0) return null
  if (issues.length === 1) return costIssueLine(issues[0])
  return `${issues.length} things to fix before this can be costed`
}
