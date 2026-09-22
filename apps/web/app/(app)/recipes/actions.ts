"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionErrorMessage } from "@/lib/backend/action-error"
import { BackendRequestError, djangoAction } from "@/lib/backend/client"
import { getPricingEntries } from "@/lib/backend/queries"
import type { RecipeDetail } from "@/lib/backend/types"
import { normalizeIngredientName } from "@/lib/pricing"
import { recipeDraftSchema } from "@/lib/recipe/draft"
import {
  recipeAggregateSchema,
  saveRecipeSchema,
} from "@/lib/recipe/aggregate-schema"
import { RECIPE_STATUSES, type RecipeStatus } from "@/lib/recipe/status"

/** A recipe edit changes the dashboard, the list, and every product cost. */
function revalidateRecipeReads() {
  revalidatePath("/")
  revalidatePath("/recipes")
  revalidatePath("/products")
}

export type SavedRecipe = {
  id: string
  publicId: string
  code: string
  /** What the row is at now; the next save sends it as its expectation. */
  editVersion: number
  /** The stored lines, returned only when the save carried `items`. */
  items?: RecipeDetail["items"]
}

export async function saveRecipe(
  input: z.input<typeof saveRecipeSchema>
): Promise<SavedRecipe | { error: string }> {
  const parsed = saveRecipeSchema.safeParse(input)
  if (!parsed.success) return { error: "Recipe details look malformed." }
  try {
    const result = await djangoAction<SavedRecipe>("save-recipe", parsed.data)
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save the recipe.") }
  }
}

/** A recipe draft supplies only names and measurements. The signed-in tenant's pantry
 * supplies every durable ingredient identity at confirmation time. */
export async function createRecipeFromDraft(
  input: unknown
): Promise<SavedRecipe | { error: string }> {
  const parsed = recipeDraftSchema.safeParse(input)
  if (!parsed.success) return { error: "That recipe draft is malformed." }
  try {
    // Pricing entries are the read that says which pantry rows are supplies;
    // a new recipe line reaches for neither a carton nor an archived row.
    const options = (await getPricingEntries()).items.filter(
      (entry) => entry.status === "active" && !entry.nonEdible
    )
    const ingredientIds = new Map<string, string | null>()
    for (const option of options) {
      const normalizedName = normalizeIngredientName(option.name)
      ingredientIds.set(
        normalizedName,
        ingredientIds.has(normalizedName) ? null : option.id
      )
    }
    const draft = parsed.data
    const result = await djangoAction<SavedRecipe>("save-recipe", {
      id: null,
      title: draft.title,
      description: draft.description,
      kind: "recipe",
      status: "active",
      body: "",
      method: "",
      ...(draft.yield
        ? {
            yieldAmount: draft.yield.amount,
            yieldUnit: draft.yield.unit,
          }
        : {}),
      items: draft.ingredients.map((ingredient) => ({
        kind: "ingredient",
        displayName: ingredient.name,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        preparationNote: ingredient.preparation,
        efficiency: 100,
        efficiencyAfterCooking: 100,
        isBase: false,
        excludedFromCost: false,
        ingredientId:
          ingredientIds.get(normalizeIngredientName(ingredient.name)) ?? null,
        subrecipeId: null,
      })),
      steps: draft.steps.map((body) => ({
        kind: "instruction",
        title: "",
        body,
        laborKind: "",
        timings: [],
      })),
      batchSizes: [],
      equivalency: null,
    })
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t create the recipe.") }
  }
}

export async function saveRecipeAggregate(
  input: z.input<typeof recipeAggregateSchema>
): Promise<
  SavedRecipe | { error: string; code?: string; editVersion?: number }
> {
  const parsed = recipeAggregateSchema.safeParse(input)
  if (!parsed.success) return { error: "Recipe details look malformed." }
  try {
    const result = await djangoAction<SavedRecipe>("save-recipe", parsed.data)
    revalidateRecipeReads()
    return result
  } catch (cause) {
    // The editor tells a refused stale write apart from every other failure.
    if (cause instanceof BackendRequestError && cause.code === "stale_write") {
      return {
        error: cause.message,
        code: cause.code,
        editVersion: cause.editVersion,
      }
    }
    return { error: actionErrorMessage(cause, "Couldn’t save the recipe.") }
  }
}

export async function shareRecipe(input: {
  recipeId: string
  email: string
  role: "viewer" | "editor"
}) {
  const parsed = z
    .object({
      recipeId: z.string().min(1),
      email: z.string().email(),
      role: z.enum(["viewer", "editor"]),
    })
    .safeParse(input)
  if (!parsed.success) return { error: "Enter a valid collaborator email." }
  try {
    // An address with no verified account comes back as an invitation link.
    const result = await djangoAction<
      | {
          id: string
          recipeId: string
          recipientId: string
          recipientName: string
          role: "viewer" | "editor"
        }
      | { guest: { id: string; email: string; role: "viewer" | "editor" } }
    >("share-recipe", parsed.data)
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t share the recipe.") }
  }
}

/** A book link stands for the whole selection; a single recipe still rotates
 * that recipe's own link, so the answer names one or the other. */
export async function shareRecipes(input: {
  recipeIds: string[]
  email: string
  role: "viewer" | "editor"
  title?: string
}) {
  const parsed = z
    .object({
      recipeIds: z.array(z.string().min(1)).min(1).max(50),
      email: z.string().email(),
      role: z.enum(["viewer", "editor"]),
      title: z.string().trim().max(120).optional(),
    })
    .safeParse(input)
  if (!parsed.success) return { error: "Enter a valid collaborator email." }
  try {
    // An address with no verified account comes back as one invitation link
    // over the whole selection; a verified one gets a share per recipe.
    const result = await djangoAction<{
      shared: number
      guest: {
        id: string
        email: string
        role: "viewer" | "editor"
        title: string
      } | null
    }>("share-recipes", parsed.data)
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t share the recipes.") }
  }
}

export async function removeRecipeBook(input: { bookId: string }) {
  const parsed = z.object({ bookId: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return { error: "That book link is malformed." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "remove-recipe-book",
      parsed.data
    )
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t revoke that link."),
    }
  }
}

export async function removeRecipeGuestLink(input: {
  recipeId: string
  linkId: string
}) {
  const parsed = z
    .object({ recipeId: z.string().min(1), linkId: z.string().min(1) })
    .safeParse(input)
  if (!parsed.success) return { error: "That guest link is malformed." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "remove-recipe-guest-link",
      parsed.data
    )
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t revoke that link."),
    }
  }
}

export async function updateRecipeShare(input: {
  recipeId: string
  shareId: string
  role: "viewer" | "editor"
}) {
  const parsed = z
    .object({
      recipeId: z.string().min(1),
      shareId: z.string().min(1),
      role: z.enum(["viewer", "editor"]),
    })
    .safeParse(input)
  if (!parsed.success) return { error: "That share is malformed." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "update-recipe-share",
      parsed.data
    )
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t update that share.") }
  }
}

export async function removeRecipeShare(input: {
  recipeId: string
  shareId: string
}) {
  const parsed = z
    .object({ recipeId: z.string().min(1), shareId: z.string().min(1) })
    .safeParse(input)
  if (!parsed.success) return { error: "That share is malformed." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "remove-recipe-share",
      parsed.data
    )
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t remove that share.") }
  }
}

export async function saveRecipeComment(input: {
  recipeId: string
  id?: string
  body: string
}) {
  const parsed = z
    .object({
      recipeId: z.string().min(1),
      id: z.string().min(1).optional(),
      body: z.string().trim().min(1).max(20000),
    })
    .safeParse(input)
  if (!parsed.success) return { error: "Comment cannot be empty." }
  try {
    const result = await djangoAction<{ id: string }>(
      "save-recipe-comment",
      parsed.data
    )
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save the comment.") }
  }
}

export async function deleteRecipeComment(id: string) {
  const parsed = z.string().min(1).safeParse(id)
  if (!parsed.success) return { error: "Comment is required." }
  try {
    const result = await djangoAction<{ ok: true }>("delete-recipe-comment", {
      id: parsed.data,
    })
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete the comment.") }
  }
}

export async function deleteRecipe(
  id: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.string().min(1).safeParse(id)
  if (!parsed.success) return { error: "Recipe id is required." }
  try {
    const result = await djangoAction<{ ok: true }>("delete-recipe", {
      id: parsed.data,
    })
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete the recipe.") }
  }
}

/**
 * The selection in one request: every recipe in turn, one revalidation at
 * the end, so the rows leave together instead of one per round trip. Stops
 * at the first failure and says how many went, so the selection can stay
 * open for a retry.
 */
export async function deleteRecipes(
  ids: string[]
): Promise<{ ok: true } | { error: string; deleted: number }> {
  const parsed = z.array(z.string().min(1)).min(1).max(200).safeParse(ids)
  if (!parsed.success) return { error: "Recipe ids are required.", deleted: 0 }
  let deleted = 0
  try {
    for (const id of parsed.data) {
      await djangoAction<{ ok: true }>("delete-recipe", { id })
      deleted += 1
    }
    return { ok: true }
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t delete the recipes."),
      deleted,
    }
  } finally {
    if (deleted) revalidateRecipeReads()
  }
}

/** A second recipe from this one, the same in everything but its name; the
 * backend copies every row so nothing a recipe holds is left behind. */
export async function duplicateRecipe(
  id: string
): Promise<SavedRecipe | { error: string }> {
  const parsed = z.string().min(1).safeParse(id)
  if (!parsed.success) return { error: "Recipe id is required." }
  try {
    const result = await djangoAction<SavedRecipe>("duplicate-recipe", {
      id: parsed.data,
    })
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t duplicate the recipe."),
    }
  }
}

/** The serving and package a label preview describes. Each optional pair is
 * sent only when the caller means to change it. */
export async function setRecipeNutritionServing(
  recipeId: string,
  serving: {
    amount?: number | null
    unit?: string
    packageAmount?: number | null
    packageUnit?: string
  }
): Promise<{ ok: true } | { error: string }> {
  const parsed = z
    .object({
      recipeId: z.string().min(1),
      amount: z.number().positive().max(1000000).nullable().optional(),
      unit: z.string().max(32).optional(),
      packageAmount: z.number().positive().max(1000000).nullable().optional(),
      packageUnit: z.string().max(32).optional(),
    })
    .safeParse({ recipeId, ...serving })
  if (!parsed.success) return { error: "Serving size looks invalid." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "set-recipe-nutrition-serving",
      parsed.data
    )
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t save the serving size."),
    }
  }
}

/** Yield after cooking for one line: the share that stays in the dish. */
export async function setRecipeItemYieldAfterCooking(
  recipeId: string,
  itemId: string,
  percent: number
): Promise<{ ok: true; editVersion: number } | { error: string }> {
  const parsed = z
    .object({
      recipeId: z.string().min(1),
      itemId: z.string().min(1),
      percent: z.number().min(0).max(100),
    })
    .safeParse({ recipeId, itemId, percent })
  if (!parsed.success) return { error: "Yield after cooking must be 0 to 100." }
  try {
    const result = await djangoAction<{ ok: true; editVersion: number }>(
      "set-recipe-item-yield-after-cooking",
      parsed.data
    )
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(
        cause,
        "Couldn’t save the yield after cooking."
      ),
    }
  }
}

/** Whether one measured line is left out of the money. */
export async function setRecipeItemExcludedFromCost(
  recipeId: string,
  itemId: string,
  excluded: boolean
): Promise<{ ok: true; editVersion: number } | { error: string }> {
  const parsed = z
    .object({
      recipeId: z.string().min(1),
      itemId: z.string().min(1),
      excluded: z.boolean(),
    })
    .safeParse({ recipeId, itemId, excluded })
  if (!parsed.success) return { error: "That line cannot be left out of cost." }
  try {
    const result = await djangoAction<{ ok: true; editVersion: number }>(
      "set-recipe-item-excluded-from-cost",
      parsed.data
    )
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t change what this line costs."),
    }
  }
}

const recipeCostingSchema = z.object({
  recipeId: z.string().min(1),
  servingAmount: z.number().positive().nullable(),
  servingUnit: z.string().max(32),
  menuPriceCents: z.number().int().min(1).max(100000000).nullable(),
})

export async function updateRecipeCosting(input: {
  recipeId: string
  servingAmount: number | null
  servingUnit: string
  menuPriceCents: number | null
}): Promise<{ ok: true } | { error: string }> {
  const parsed = recipeCostingSchema.safeParse(input)
  if (
    !parsed.success ||
    (parsed.data.servingAmount === null) !== !parsed.data.servingUnit
  ) {
    return { error: "Costing details look malformed." }
  }
  try {
    const result = await djangoAction<{ ok: true }>(
      "update-recipe-costing",
      parsed.data
    )
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save recipe costing.") }
  }
}

/**
 * Archive or restore a selection in one request and one transaction: either
 * every recipe moves or none does, and the rows change together. One id is
 * the row menu's case. The revalidation is the refresh.
 */
export async function updateRecipeStatuses(
  ids: string[],
  status: RecipeStatus
): Promise<{ ok: true; changed: number } | { error: string }> {
  const parsed = z
    .object({
      recipeIds: z.array(z.string().min(1)).min(1).max(200),
      status: z.enum(RECIPE_STATUSES),
    })
    .safeParse({ recipeIds: ids, status })
  if (!parsed.success) return { error: "Unknown recipe status." }
  try {
    const result = await djangoAction<{ ok: true; changed: number }>(
      "update-recipe-statuses",
      parsed.data
    )
    revalidateRecipeReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t update the recipe status."),
    }
  }
}
