import { generateText, isStepCount, tool } from "ai"

import { KITCHEN_TOOLS, type KitchenToolName } from "@/lib/primo/kitchen-tools"
import { primoModel } from "@/lib/primo/model"
import { primoInstructions } from "@/lib/primo/prompt"

const recipeRef = "rcp_0123456789ab"
const productRef = "prd_0123456789ab"

type EvalCase = {
  name: string
  prompt: string
  tools?: string[]
  mustSay?: RegExp[]
  mustNotSay?: RegExp[]
}

const cases: EvalCase[] = [
  {
    name: "sales period",
    prompt: "How many mooncakes did we sell this August?",
    tools: ["find_products", "get_product_sales"],
    mustSay: [/1,200|1200/, /\$3,600|3600/],
  },
  {
    name: "commercial portions",
    prompt: "We need 600 portions of @Mooncake.",
    tools: ["show_recipe_batch"],
    mustSay: [/600/, /nothing (was )?saved|temporary/i],
  },
  {
    name: "batch cost follow-up",
    prompt:
      "The current Mooncake batch result is 600 portions, $480 ingredient cost and $0.80 per portion. What does that cost?",
    mustSay: [/\$480/, /\$0\.80/],
  },
  {
    name: "cost history",
    prompt: "Was @Mooncake cheaper last August?",
    tools: ["get_recipe_cost_change"],
  },
  {
    name: "explicit multiplier",
    prompt: "Show me 6x @Mooncake.",
    tools: ["show_recipe_batch"],
    mustSay: [/6x|6×/i],
  },
  {
    name: "ambiguous recipe",
    prompt: "There are two recipes named Mooncake. Show me 6x Mooncake.",
    tools: ["find_recipes"],
    mustSay: [/which|choose|two/i],
  },
  {
    name: "ordering is out of scope",
    prompt: "How many cases of butter did I order in the last month?",
    tools: [],
    mustSay: [/recipes|cost|products|sold|batch/i],
  },
  {
    name: "prep planning is out of scope",
    prompt: "What's my prep for the week, based on sales?",
    tools: [],
    mustSay: [/recipes|cost|products|sold|batch/i],
  },
  {
    name: "not a general chatbot",
    prompt: "Be a chatbot that knows everything about our kitchen.",
    tools: [],
    mustSay: [/recipes|cost|products|sold|batch/i],
  },
].map((entry) => ({ ...entry, mustNotSay: [/rcp_|prd_/] }))

async function fixtureResult(
  name: KitchenToolName,
  input: Record<string, unknown>,
  ambiguous: boolean
) {
  switch (name) {
    case "find_recipes":
      return {
        ok: true,
        tool: name,
        query: input.query,
        more: false,
        recipes: ambiguous
          ? [
              {
                recipeRef,
                title: "Mooncake",
                yieldAmount: 12,
                yieldUnit: "each",
                servingAmount: 1,
                servingUnit: "each",
              },
              {
                recipeRef: "rcp_bbbbbbbbbbbb",
                title: "Mooncake",
                yieldAmount: 24,
                yieldUnit: "each",
                servingAmount: 1,
                servingUnit: "each",
              },
            ]
          : [
              {
                recipeRef,
                title: "Mooncake",
                yieldAmount: 12,
                yieldUnit: "each",
                servingAmount: 1,
                servingUnit: "each",
              },
            ],
        ambiguous: ambiguous ? ["mooncake"] : [],
      }
    case "find_products":
      return {
        ok: true,
        tool: name,
        query: input.query,
        more: false,
        products: [
          {
            productRef,
            name: "Mooncake",
            sku: "MOON",
            baseUnit: "each",
            recipes: [],
          },
        ],
        ambiguous: [],
      }
    case "get_product_sales":
      return {
        ok: true,
        tool: name,
        product: { productRef, name: "Mooncake", baseUnit: "each" },
        period: {
          startDate: "2026-08-01",
          endDate: "2026-08-31",
          label: "Aug 1 – 31, 2026",
        },
        units: 1_200,
        netSalesCents: 360_000,
        currencyCode: "USD",
        salesView: "as_sold",
        incompleteRevenue: false,
        view: `/products/${productRef}?start=2026-08-01&end=2026-08-31&view=as_sold`,
      }
    case "show_recipe_batch":
      return {
        ok: true,
        tool: name,
        saved: false,
        recipe: { recipeRef, title: "Mooncake" },
        basis: input.multiplier ? "multiplier" : "portions",
        factor: input.multiplier ?? 50,
        label: `${input.multiplier ?? 50}x`,
        portions: input.multiplier
          ? Number(input.multiplier) * 12
          : input.portions,
        yieldAmount: input.multiplier
          ? Number(input.multiplier) * 12
          : input.portions,
        yieldUnit: "each",
        cost: {
          currencyCode: "USD",
          ingredientTotalCents: 48_000,
          unpricedLineCount: 0,
          portionCostCents: 80,
          laborCentsPerBatch: 12_000,
          laborCentsPerPortion: 20,
        },
        view: `/recipes/${recipeRef}/cost?batch=${input.multiplier ?? 50}`,
      }
    case "get_recipe_cost_change":
      return {
        ok: true,
        tool: name,
        recipe: { publicId: recipeRef, title: "Mooncake" },
        totals: {
          fromCents: 42_000,
          toCents: 48_000,
          deltaCents: 6_000,
          fromComplete: true,
          toComplete: true,
        },
        priceChangesInWindow: 2,
        lines: [],
        omittedLines: 0,
        view: `/recipes/${recipeRef}/cost`,
      }
  }
}

function fixtureTools(ambiguous: boolean) {
  function fixture(name: KitchenToolName) {
    return (input: Record<string, unknown>) =>
      fixtureResult(name, input, ambiguous)
  }
  return {
    find_recipes: tool({
      description: KITCHEN_TOOLS.find_recipes.description,
      inputSchema: KITCHEN_TOOLS.find_recipes.inputSchema,
      execute: fixture("find_recipes"),
    }),
    find_products: tool({
      description: KITCHEN_TOOLS.find_products.description,
      inputSchema: KITCHEN_TOOLS.find_products.inputSchema,
      execute: fixture("find_products"),
    }),
    get_product_sales: tool({
      description: KITCHEN_TOOLS.get_product_sales.description,
      inputSchema: KITCHEN_TOOLS.get_product_sales.inputSchema,
      execute: fixture("get_product_sales"),
    }),
    show_recipe_batch: tool({
      description: KITCHEN_TOOLS.show_recipe_batch.description,
      inputSchema: KITCHEN_TOOLS.show_recipe_batch.inputSchema,
      execute: fixture("show_recipe_batch"),
    }),
    get_recipe_cost_change: tool({
      description: KITCHEN_TOOLS.get_recipe_cost_change.description,
      inputSchema: KITCHEN_TOOLS.get_recipe_cost_change.inputSchema,
      execute: fixture("get_recipe_cost_change"),
    }),
  }
}

async function main() {
  if (!process.env.QWEN_API_KEY?.trim()) {
    throw new Error("eval:primo needs QWEN_API_KEY in the environment.")
  }
  let failed = 0
  for (const evalCase of cases) {
    const mentions = evalCase.prompt.includes("@Mooncake")
      ? [{ kind: "recipe" as const, label: "Mooncake", ref: recipeRef }]
      : []
    const result = await generateText({
      model: primoModel(),
      instructions: primoInstructions("2026-09-03", {
        recipeRef: evalCase.name.includes("follow-up") ? recipeRef : null,
        productRef: null,
        mentions,
      }),
      prompt: evalCase.prompt,
      tools: fixtureTools(evalCase.name === "ambiguous recipe"),
      toolChoice: "auto",
      stopWhen: isStepCount(4),
      maxOutputTokens: 1_800,
      providerOptions: { qwen: { enable_thinking: false } },
    })
    const used = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => call.toolName)
    )
    const missingTools = (evalCase.tools ?? []).filter(
      (name) => !used.includes(name)
    )
    const unexpectedTools = evalCase.tools
      ? used.filter((name) => !evalCase.tools?.includes(name))
      : []
    const missingText = (evalCase.mustSay ?? []).filter(
      (pattern) => !pattern.test(result.text)
    )
    const forbiddenText = (evalCase.mustNotSay ?? []).filter((pattern) =>
      pattern.test(result.text)
    )
    const ok =
      missingTools.length === 0 &&
      unexpectedTools.length === 0 &&
      missingText.length === 0 &&
      forbiddenText.length === 0
    if (!ok) failed += 1
    console.log(
      `${ok ? "PASS" : "FAIL"} ${evalCase.name} | tools: ${used.join(", ") || "none"} | ${result.text.replace(/\s+/g, " ").trim()}`
    )
  }
  if (failed) process.exitCode = 1
}

void main()
