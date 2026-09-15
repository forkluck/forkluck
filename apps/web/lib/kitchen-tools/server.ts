import "server-only"
import { calculateBatchCost, type BatchCalculationInput } from "./calculations"

import { cookies } from "next/headers"

import { getSession } from "@/lib/auth-session"
import {
  browseMenuItems,
  browseRecipes,
  getBusinessSettings,
  getProductDetail,
  getRecipe,
  getRecipeCostDiff,
  getSalesOverview,
  getIngredientPriceChanges,
} from "@/lib/backend/queries"
import type { RecipeCostDiff } from "@/lib/backend/types"
import { scaleBatchCost } from "@/lib/benchcost/math"
import { resolvePeriod } from "@/lib/date-range-label"
import { localDateKey } from "@/lib/date-presets"
import { KITCHEN_COOKIE, resolveActiveKitchen } from "@/lib/kitchen"
import { KITCHEN_TOOLS, type KitchenToolName } from "./catalog"
import type { KitchenToolFailure, KitchenToolResult } from "./results"
import { normalizeIngredientName } from "@/lib/pricing"
import { recipePortions, recipePrepTimeSeconds } from "@/lib/recipe/portions"
import {
  clampScaleFactor,
  formatAppliedScaleFactor,
  scaleFromRequestedYield,
} from "@/lib/recipe/scale"

export type RecipeCostDiffProjection = RecipeCostDiff & { omittedLines: number }

export function projectCostDiff(
  value: RecipeCostDiff
): RecipeCostDiffProjection {
  const lines = [...value.lines].sort(
    (left, right) =>
      Math.abs(right.deltaCents ?? 0) - Math.abs(left.deltaCents ?? 0)
  )
  return {
    ...value,
    lines: lines.slice(0, 40),
    omittedLines: Math.max(0, lines.length - 40),
  }
}

export function kitchenToolFailure(
  toolName: KitchenToolName,
  reason: KitchenToolFailure["reason"],
  message: string
): KitchenToolFailure {
  return { ok: false, tool: toolName, reason, message }
}

function ambiguousNames(rows: Array<{ normalizedName: string }>) {
  const counts = new Map<string, number>()
  for (const row of rows) {
    counts.set(row.normalizedName, (counts.get(row.normalizedName) ?? 0) + 1)
  }
  return [...counts].filter(([, count]) => count > 1).map(([name]) => name)
}

export async function kitchenToday(): Promise<string> {
  return localDateKey((await getBusinessSettings()).timezone)
}

function inputForParsing(name: KitchenToolName, input: unknown) {
  if (
    name !== "show_recipe_batch" ||
    !input ||
    typeof input !== "object" ||
    !("multiplier" in input) ||
    typeof input.multiplier !== "number"
  ) {
    return input
  }
  const multiplier = clampScaleFactor(input.multiplier)
  return multiplier === null ? input : { ...input, multiplier }
}

export async function runKitchenTool(
  name: KitchenToolName,
  input: unknown
): Promise<KitchenToolResult> {
  const parsed = KITCHEN_TOOLS[name].inputSchema.safeParse(
    inputForParsing(name, input)
  )
  if (!parsed.success) {
    return kitchenToolFailure(
      name,
      "bad_input",
      parsed.error.issues[0]?.message ?? "That tool input is not valid."
    )
  }
  const value = parsed.data as Record<string, unknown>

  if (name === "calculate_batch_cost")
    return calculateBatchCost(parsed.data as BatchCalculationInput)

  if (name === "get_ingredient_price_changes") {
    const period = resolvePeriod(String(value.period), await kitchenToday())
    if (!period)
      return kitchenToolFailure(
        name,
        "bad_period",
        "Choose a past or current calendar period."
      )
    return {
      ...(await getIngredientPriceChanges(period.startDate, period.endDate)),
      ok: true,
      tool: name,
      period,
      view: "/ingredients",
    }
  }

  if (name === "get_top_products") {
    const period = resolvePeriod(String(value.period), await kitchenToday())
    if (!period)
      return kitchenToolFailure(
        name,
        "bad_period",
        "Choose a past or current calendar period."
      )
    const overview = await getSalesOverview(period.startDate, period.endDate)
    const products = new Map<
      string,
      { name: string; netSalesCents: number; incomplete: boolean }
    >()
    for (const row of overview.topProducts) {
      // Analytics has already allocated bundle revenue. Its bundle shell
      // rows carry units only and do not belong in a revenue ranking.
      if (row.sharedToMembers) continue
      const product = products.get(row.productId) ?? {
        name: row.productName,
        netSalesCents: 0,
        incomplete: false,
      }
      product.netSalesCents += row.netSalesCents ?? 0
      product.incomplete ||= row.netSalesCents === null
      products.set(row.productId, product)
    }
    const ranked = [...products.values()]
      .filter((row) => !row.incomplete)
      .sort(
        (a, b) =>
          b.netSalesCents - a.netSalesCents || a.name.localeCompare(b.name)
      )
    const limit = Number(value.limit)
    return {
      ok: true,
      tool: name,
      period,
      currencyCode: overview.summary.currencyCode,
      salesView: "including_bundles",
      products: ranked
        .slice(0, limit)
        .map(({ name, netSalesCents }) => ({ name, netSalesCents })),
      hasRecordedProducts: overview.topProducts.length > 0,
      unrankedProducts: [...products.values()].filter((row) => row.incomplete)
        .length,
      more: ranked.length > limit,
      coverage:
        "Analytics including-bundles view: allocated bundle and modifier revenue is counted once. Only tracked products in the kitchen currency are included; this does not establish complete sales coverage.",
      view: `/analytics?${new URLSearchParams({ start: period.startDate, end: period.endDate })}`,
    }
  }

  if (name === "find_recipes") {
    const query = String(value.query)
    const [session, cookieStore] = await Promise.all([getSession(), cookies()])
    const kitchen = session
      ? resolveActiveKitchen(session, cookieStore.get(KITCHEN_COOKIE)?.value)
      : null
    const result = await browseRecipes({
      page: 1,
      limit: 9,
      q: query,
      filters: { status: "active", kitchen: kitchen?.ownerId ?? null },
    })
    return {
      ok: true,
      tool: name,
      query,
      more: result.meta.pagination.next !== null,
      recipes: result.items.map((recipe) => ({
        recipeRef: recipe.publicId,
        title: recipe.title,
        yieldAmount: recipe.yieldAmount,
        yieldUnit: recipe.yieldUnit,
        servingAmount: recipe.servingAmount ?? null,
        servingUnit: recipe.servingUnit ?? "",
      })),
      ambiguous: ambiguousNames(
        result.items.map((recipe) => ({
          normalizedName: normalizeIngredientName(recipe.title),
        }))
      ),
    }
  }

  if (name === "find_products") {
    const query = String(value.query)
    const result = await browseMenuItems({
      page: 1,
      limit: 9,
      q: query,
      order: "name",
      filters: { status: "active" },
    })
    return {
      ok: true,
      tool: name,
      query,
      more: result.meta.pagination.next !== null,
      products: result.items.map((product) => ({
        productRef: product.publicId,
        name: product.name,
        sku: product.sku,
        baseUnit: product.baseUnit || "each",
        recipes: product.recipeLinks.map((recipe) => ({
          recipeRef: recipe.publicId,
          title: recipe.recipeTitle,
        })),
      })),
      ambiguous: ambiguousNames(result.items),
    }
  }

  if (name === "get_product_sales") {
    const productRef = String(value.productRef)
    const period = resolvePeriod(String(value.period), await kitchenToday())
    if (!period) {
      return kitchenToolFailure(
        name,
        "bad_period",
        "That sales period is not a valid past or current calendar period."
      )
    }
    const product = await getProductDetail(
      productRef,
      period.startDate,
      period.endDate
    )
    if (!product) {
      return kitchenToolFailure(
        name,
        "not_found",
        "That product could not be found."
      )
    }
    const sales = product.salesAsSold ?? product.sales
    const params = new URLSearchParams({
      start: period.startDate,
      end: period.endDate,
      view: "as_sold",
    })
    return {
      ok: true,
      tool: name,
      product: {
        productRef: product.publicId,
        name: product.name,
        baseUnit: product.baseUnit || "each",
      },
      period,
      units: sales.totalQuantity,
      netSalesCents: sales.netSalesCents,
      currencyCode: product.currencyCode,
      salesView: "as_sold",
      incompleteRevenue: product.incompleteManualRevenue,
      view: `/products/${product.publicId}?${params}`,
    }
  }

  if (name === "show_recipe_batch") {
    const recipeRef = String(value.recipeRef)
    const recipe = await getRecipe(recipeRef)
    if (!recipe) {
      return kitchenToolFailure(
        name,
        "not_found",
        "That recipe could not be found."
      )
    }
    const requestedMultiplier =
      typeof value.multiplier === "number" ? value.multiplier : null
    const requestedPortions =
      typeof value.portions === "number" ? value.portions : null
    if (requestedMultiplier === null && requestedPortions === null) {
      return kitchenToolFailure(
        name,
        "bad_input",
        "Give me a portion count or a batch multiplier."
      )
    }
    const basePortions = recipePortions(recipe, {
      amount: recipe.servingAmount ?? null,
      unit: recipe.servingUnit ?? "",
    })
    const requestedScale =
      requestedMultiplier !== null
        ? { factor: requestedMultiplier }
        : requestedPortions !== null && basePortions !== null
          ? scaleFromRequestedYield(basePortions, requestedPortions)
          : null
    if (!requestedScale) {
      return kitchenToolFailure(
        name,
        "needs_scale",
        "This recipe has no portion size. Give me a multiplier or a yield amount."
      )
    }
    const factor = requestedScale.factor
    const portions = basePortions === null ? null : basePortions * factor
    const settings = recipe.canViewCost ? await getBusinessSettings() : null
    const batch = settings
      ? scaleBatchCost({
          lineCostCents: recipe.items
            .filter(
              (item) => item.kind === "ingredient" || item.kind === "subrecipe"
            )
            .map((item) => item.costCents),
          basePortions,
          prepTimeSeconds: recipePrepTimeSeconds(recipe),
          autoPrepTime: recipe.autoPrepTimeEnabled ?? false,
          steps: recipe.steps.map((step, index) => ({
            id: String(index),
            kind: step.laborKind === "active" ? "active" : "passive",
            timings: step.timings.map((timing) => ({
              seconds: timing.seconds,
              yieldCount: 1,
            })),
          })),
          wagePerHourCents: settings.wagePerHourCents,
          scale: factor,
        })
      : null
    return {
      ok: true,
      tool: name,
      saved: false,
      recipe: { recipeRef: recipe.publicId, title: recipe.title },
      basis: requestedMultiplier !== null ? "multiplier" : "portions",
      factor,
      label: `${formatAppliedScaleFactor(factor)}x`,
      portions,
      yieldAmount:
        recipe.yieldAmount === null ? null : recipe.yieldAmount * factor,
      yieldUnit: recipe.yieldUnit,
      cost:
        settings && batch
          ? {
              currencyCode: settings.currencyCode,
              ingredientTotalCents: batch.ingredientTotalCents,
              unpricedLineCount: batch.unpricedLineCount,
              portionCostCents: batch.portionCostCents,
              laborCentsPerBatch: batch.labor.laborCentsPerBatch,
              laborCentsPerPortion: batch.labor.laborCentsPerPiece,
            }
          : null,
      view: `/recipes/${recipe.publicId}/${recipe.canViewCost ? "cost" : "recipe"}?batch=${factor}`,
    }
  }

  const recipeRef = String(value.recipeRef)
  let from: string | undefined
  if (typeof value.since === "string") {
    const period = resolvePeriod(value.since, await kitchenToday())
    if (!period) {
      return kitchenToolFailure(
        name,
        "bad_period",
        "That comparison period is not a valid past or current calendar period."
      )
    }
    from = period.startDate
  }
  const result = await getRecipeCostDiff(recipeRef, from)
  if (!result) {
    return kitchenToolFailure(
      name,
      "owner_only",
      "Only the recipe's owner can compare its cost history."
    )
  }
  return {
    ok: true,
    tool: name,
    view: `/recipes/${recipeRef}/cost`,
    ...projectCostDiff(result),
  }
}
