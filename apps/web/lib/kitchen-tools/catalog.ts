import { z } from "zod"
import { batchCalculationSchema } from "./calculations"

export const RECIPE_REF = /^rcp_[0-9abcdefghjkmnpqrstvwxyz]{12}$/
export const PRODUCT_REF = /^prd_[0-9abcdefghjkmnpqrstvwxyz]{12}$/
export const PERIOD_TEXT =
  "YYYY, YYYY-MM, YYYY-MM-DD, YYYY-MM-DD..YYYY-MM-DD, or a preset id"

export const KITCHEN_TOOL_NAMES = [
  "find_recipes",
  "find_products",
  "get_product_sales",
  "show_recipe_batch",
  "get_recipe_cost_change",
  "calculate_batch_cost",
  "get_top_products",
  "get_ingredient_price_changes",
] as const

export type KitchenToolName = (typeof KITCHEN_TOOL_NAMES)[number]

export type KitchenToolEntry = {
  name: KitchenToolName
  title: string
  description: string
  inputSchema: z.ZodObject
  annotations: {
    readOnlyHint: true
    untrustedContentHint: true
  }
}

const annotations = {
  readOnlyHint: true,
  untrustedContentHint: true,
} as const

export const KITCHEN_TOOLS: Record<KitchenToolName, KitchenToolEntry> = {
  get_ingredient_price_changes: {
    name: "get_ingredient_price_changes",
    title: "Read ingredient price changes",
    description:
      "Compare recorded ingredient prices before a kitchen calendar period with its last recorded prices. Reports normalized unit prices, missing earlier history and incompatible units; never adds per-unit costs across ingredients. Defaults to the last 30 days.",
    inputSchema: z.strictObject({
      period: z
        .string()
        .trim()
        .min(4)
        .max(22)
        .default("last_30_days")
        .describe(PERIOD_TEXT),
    }),
    annotations,
  },
  get_top_products: {
    name: "get_top_products",
    title: "Rank product sales",
    description:
      "Rank products by net sales for a calendar period using Analytics' including-bundles view. Bundle revenue is allocated to members, never added twice. Products with missing revenue are disclosed and excluded from ranking. This is a read, not a forecast.",
    inputSchema: z.strictObject({
      period: z.string().trim().min(4).max(22).describe(PERIOD_TEXT),
      limit: z.number().int().min(1).max(10).default(3),
    }),
    annotations,
  },
  calculate_batch_cost: {
    name: "calculate_batch_cost",
    title: "Calculate batch costs",
    description:
      "Calculate hypothetical batch costs, contribution, margin, markup and a target-margin selling price from explicit assumptions. Monetary amounts are major currency units, ingredient and other costs per batch, packaging and selling price per portion. Without an explicit target margin, preserve the baseline margin. This reads no saved prices and saves nothing.",
    inputSchema: batchCalculationSchema,
    annotations,
  },
  find_recipes: {
    name: "find_recipes",
    title: "Find recipes",
    description:
      "Find active recipes in the kitchen currently open in Forkluck. Use this before a recipe tool when no recipe was explicitly selected.",
    inputSchema: z.strictObject({
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Words from the recipe name as the user said them."),
    }),
    annotations,
  },
  find_products: {
    name: "find_products",
    title: "Find products",
    description:
      "Find active products by name, SKU, or POS title. Use the returned product reference for an exact sales read.",
    inputSchema: z.strictObject({
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Words from the product name or SKU as the user said them."),
    }),
    annotations,
  },
  get_product_sales: {
    name: "get_product_sales",
    title: "Get product sales",
    description:
      "Read the as-sold ledger for one exact product and calendar period, then open the same product and period in Forkluck.",
    inputSchema: z.strictObject({
      productRef: z
        .string()
        .regex(PRODUCT_REF)
        .describe("Exact product reference returned by find_products."),
      period: z.string().trim().min(4).max(22).describe(PERIOD_TEXT),
    }),
    annotations,
  },
  show_recipe_batch: {
    name: "show_recipe_batch",
    title: "Show recipe batch",
    description:
      "Open one exact recipe at a requested commercial-portion count or multiplier. This is a temporary view and saves nothing.",
    inputSchema: z.strictObject({
      recipeRef: z
        .string()
        .regex(RECIPE_REF)
        .describe(
          "Exact recipe reference returned by find_recipes or an @ pick."
        ),
      portions: z
        .number()
        .finite()
        .positive()
        .max(1_000_000)
        .optional()
        .describe("Commercial portions to prepare."),
      multiplier: z
        .number()
        .finite()
        .positive()
        .max(1_000)
        .optional()
        .describe("Batch multiplier. When present, this wins over portions."),
    }),
    annotations,
  },
  get_recipe_cost_change: {
    name: "get_recipe_cost_change",
    title: "Get recipe cost change",
    description:
      "Compare one exact recipe's current cost with an earlier calendar period, then open its Cost tab. Omit since for the default comparison.",
    inputSchema: z.strictObject({
      recipeRef: z
        .string()
        .regex(RECIPE_REF)
        .describe(
          "Exact recipe reference returned by find_recipes or an @ pick."
        ),
      since: z
        .string()
        .trim()
        .min(4)
        .max(22)
        .optional()
        .describe(`Optional comparison start: ${PERIOD_TEXT}.`),
    }),
    annotations,
  },
}

export type KitchenToolDescriptor = {
  name: KitchenToolName
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: KitchenToolEntry["annotations"]
}

export function kitchenToolDescriptors(): KitchenToolDescriptor[] {
  return JSON.parse(
    JSON.stringify(
      KITCHEN_TOOL_NAMES.map((name) => {
        const entry = KITCHEN_TOOLS[name]
        return {
          name: entry.name,
          title: entry.title,
          description: entry.description,
          inputSchema: z.toJSONSchema(entry.inputSchema),
          annotations: entry.annotations,
        }
      })
    )
  ) as KitchenToolDescriptor[]
}
