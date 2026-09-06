"use server"

import { refresh, revalidatePath } from "next/cache"
import { z } from "zod"

import { requireUser } from "@/lib/auth-session"
import { actionErrorMessage } from "@/lib/backend/action-error"
import { BackendRequestError, djangoAction } from "@/lib/backend/client"
import { getPricingEntries, getRecipe } from "@/lib/backend/queries"
import type { RecipeDetail } from "@/lib/backend/types"
import { normalizeIngredientName } from "@/lib/pricing"
import { primoRecipeDraftSchema } from "@/lib/primo/recipe"
import { MAX_RECIPE_CATEGORY_LENGTH } from "@/lib/recipe/categories"
import { RECIPE_KINDS } from "@/lib/recipe/kinds"
import { RECIPE_STATUSES, type RecipeStatus } from "@/lib/recipe/status"
import { YIELD_UNIT_VALUES } from "@/lib/unit-registry"

/** A recipe edit changes the dashboard, the list, and every product cost. */
function revalidateRecipeReads() {
  revalidatePath("/")
  revalidatePath("/recipes")
  revalidatePath("/products")
}

const saveRecipeSchema = z.object({
  id: z.string().min(1).nullable(),
  // The kitchen a create belongs to. A caller who is an editor there spends
  // the owner's cap; the backend refuses every other owner.
  ownerId: z.string().min(1).optional(),
  title: z.string().max(200),
  kind: z.enum(RECIPE_KINDS).optional(),
  status: z.enum(RECIPE_STATUSES).optional(),
  body: z.string().max(200000).optional(),
  method: z.string().max(200000).optional(),
  yieldAmount: z.number().positive().max(1000000).nullable().optional(),
  yieldUnit: z.enum(YIELD_UNIT_VALUES).optional(),
  menuPriceCents: z.number().int().min(1).max(100000000).nullable().optional(),
  category: z
    .string()
    .trim()
    .min(1)
    .max(MAX_RECIPE_CATEGORY_LENGTH)
    .nullable()
    .optional(),
  description: z.string().max(200000).optional(),
  servingAmount: z.number().positive().nullable().optional(),
  servingUnit: z.string().max(32).optional(),
  nutritionServingAmount: z.number().positive().nullable().optional(),
  nutritionServingUnit: z.string().max(32).optional(),
  nutritionPackageAmount: z.number().positive().nullable().optional(),
  nutritionPackageUnit: z.string().max(32).optional(),
  shelfLifeAmount: z.number().positive().nullable().optional(),
  shelfLifeUnit: z.string().max(32).optional(),
  prepTimeAmount: z.number().positive().nullable().optional(),
  prepTimeUnit: z.string().max(32).optional(),
  autoSumYieldEnabled: z.boolean().optional(),
  autoPrepTimeEnabled: z.boolean().optional(),
  percentageMode: z.string().max(32).optional(),
  percentIngredientEnabled: z.boolean().optional(),
  percentIngredientType: z.string().max(32).optional(),
})

export type SavedRecipe = {
  id: string
  publicId: string
  code: string
  /** What the row is at now; the next save sends it as its expectation. */
  editVersion: number
  /** The stored lines, returned only when the save carried `items`. */
  items?: RecipeDetail["items"]
}

/** The recipe cap refuses a create with a code the caller turns into the
 * upgrade dialog; unlike a lapsed subscription it must not redirect, which
 * would discard the editor state the user is mid-save on. */
function atRecipeLimit(cause: unknown): cause is BackendRequestError {
  return (
    cause instanceof BackendRequestError &&
    cause.code === "recipe_limit_reached"
  )
}

export async function saveRecipe(
  input: z.input<typeof saveRecipeSchema>
): Promise<SavedRecipe | { error: string; code?: string }> {
  const parsed = saveRecipeSchema.safeParse(input)
  if (!parsed.success) return { error: "Recipe details look malformed." }
  try {
    const result = await djangoAction<SavedRecipe>("save-recipe", parsed.data)
    revalidateRecipeReads()
    return result
  } catch (cause) {
    const error = actionErrorMessage(cause, "Couldn’t save the recipe.")
    if (atRecipeLimit(cause)) return { error, code: cause.code }
    return { error }
  }
}

/** Primo proposes only names and measurements. The signed-in tenant's pantry
 * supplies every durable ingredient identity at confirmation time. */
export async function createPrimoRecipe(
  input: unknown
): Promise<SavedRecipe | { error: string; code?: string }> {
  const parsed = primoRecipeDraftSchema.safeParse(input)
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
    const error = actionErrorMessage(cause, "Couldn’t create the recipe.")
    if (atRecipeLimit(cause)) return { error, code: cause.code }
    return { error }
  }
}

const recipeItemSchema = z.object({
  id: z.uuid().optional(),
  kind: z.enum(["header", "note", "ingredient", "subrecipe"]),
  displayName: z.string().max(200),
  quantity: z.number().positive().nullable(),
  unit: z.string().max(32),
  preparationNote: z.string().max(200),
  efficiency: z.number().positive().max(9999).optional(),
  // Yield after cooking: the share of the line that stays in the dish.
  efficiencyAfterCooking: z.number().min(0).max(100).optional(),
  isBase: z.boolean().optional(),
  excludedFromCost: z.boolean().optional(),
  ingredientId: z.string().min(1).nullable().optional(),
  subrecipeId: z.string().min(1).nullable().optional(),
})

const recipeStepSchema = z.object({
  kind: z.enum(["instruction", "header", "note"]),
  title: z.string().max(200),
  body: z.string().max(200000),
  laborKind: z.enum(["", "active", "passive"]),
  timings: z
    .array(
      z.object({
        seconds: z.number().int().positive().max(86400),
        yieldCount: z.number().int().positive().max(1000000),
      })
    )
    .max(50),
})

const recipeBatchSchema = z.object({
  label: z.string().max(120),
  scale: z.number().positive().max(1000000),
  isOriginal: z.boolean(),
})

const recipeEquivalencySchema = z.object({
  massAmount: z.number().positive().nullable(),
  massUnit: z.string().max(32),
  volumeAmount: z.number().positive().nullable(),
  volumeUnit: z.string().max(32),
  countAmount: z.number().positive().nullable(),
  countUnit: z.string().max(32),
  standard: z.boolean(),
})

const duplicateRecipeSchema = saveRecipeSchema.extend({
  items: z.array(recipeItemSchema).max(1000),
  steps: z.array(recipeStepSchema).max(1000),
  batchSizes: z.array(recipeBatchSchema).max(100),
  equivalency: recipeEquivalencySchema.nullable(),
  tagIds: z.array(z.string().min(1)).max(100),
})

const recipeAggregateSchema = saveRecipeSchema.extend({
  items: z.array(recipeItemSchema).max(1000),
  steps: z.array(recipeStepSchema).max(1000),
  batchSizes: z.array(recipeBatchSchema).max(100).optional(),
  equivalency: recipeEquivalencySchema.nullable().optional(),
  // Owner payloads only: a shared editor omitting the key preserves them.
  tags: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  expectedEditVersion: z.number().int().min(0).optional(),
})

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
    const error = actionErrorMessage(cause, "Couldn’t save the recipe.")
    if (atRecipeLimit(cause)) return { error, code: cause.code }
    return { error }
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
    refresh()
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
    refresh()
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
    refresh()
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
    refresh()
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
    refresh()
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
    refresh()
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
    refresh()
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
    refresh()
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

export async function duplicateRecipe(
  id: string
): Promise<SavedRecipe | { error: string; code?: string }> {
  await requireUser()
  const parsed = z.string().min(1).safeParse(id)
  if (!parsed.success) return { error: "Recipe id is required." }
  try {
    const recipe = await getRecipe(parsed.data)
    if (!recipe) return { error: "Recipe not found." }
    if (recipe.permission !== "owner") {
      return { error: "Only the recipe owner can duplicate it." }
    }
    const copy = duplicateRecipeSchema.safeParse({
      id: null,
      title: `${recipe.title} (copy)`.slice(0, 200),
      kind: "recipe",
      status: "active",
      body: "",
      method: "",
      yieldAmount: recipe.yieldAmount,
      yieldUnit: recipe.yieldUnit ?? undefined,
      menuPriceCents: recipe.menuPriceCents,
      category: recipe.category,
      description: recipe.description,
      servingAmount: recipe.servingAmount,
      servingUnit: recipe.servingUnit,
      nutritionServingAmount: recipe.nutritionServingAmount,
      nutritionServingUnit: recipe.nutritionServingUnit,
      nutritionPackageAmount: recipe.nutritionPackageAmount,
      nutritionPackageUnit: recipe.nutritionPackageUnit,
      shelfLifeAmount: recipe.shelfLifeAmount,
      shelfLifeUnit: recipe.shelfLifeUnit,
      prepTimeAmount: recipe.prepTimeAmount,
      prepTimeUnit: recipe.prepTimeUnit,
      autoSumYieldEnabled: recipe.autoSumYieldEnabled,
      autoPrepTimeEnabled: recipe.autoPrepTimeEnabled,
      percentageMode: recipe.percentageMode,
      percentIngredientEnabled: recipe.percentIngredientEnabled,
      percentIngredientType: recipe.percentIngredientType,
      items: recipe.items.map((item) => ({
        kind: item.kind,
        displayName: item.displayName,
        quantity: item.quantity,
        unit: item.unit,
        preparationNote: item.preparationNote,
        efficiency: item.efficiency,
        efficiencyAfterCooking: item.efficiencyAfterCooking,
        ingredientId: item.ingredientId,
        subrecipeId: item.subrecipeId,
      })),
      steps: recipe.steps.map((step) => ({
        kind: step.kind === "note" ? "note" : "instruction",
        title: step.title,
        body: step.body,
        laborKind: step.laborKind,
        timings: step.timings.map(({ seconds, yieldCount }) => ({
          seconds,
          yieldCount,
        })),
      })),
      batchSizes: recipe.batchSizes.map(({ label, scale, isOriginal }) => ({
        label,
        scale,
        isOriginal,
      })),
      equivalency: recipe.equivalency
        ? {
            massAmount: recipe.equivalency.massAmount,
            massUnit: recipe.equivalency.massUnit,
            volumeAmount: recipe.equivalency.volumeAmount,
            volumeUnit: recipe.equivalency.volumeUnit,
            countAmount: recipe.equivalency.countAmount,
            countUnit: recipe.equivalency.countUnit,
            standard: recipe.equivalency.standard,
          }
        : null,
      tagIds: recipe.tags.map((tag) => tag.id),
    })
    if (!copy.success) return { error: "Couldn’t duplicate the recipe." }
    const result = await djangoAction<SavedRecipe>("save-recipe", copy.data)
    revalidateRecipeReads()
    refresh()
    return result
  } catch (cause) {
    const error = actionErrorMessage(cause, "Couldn’t duplicate the recipe.")
    if (atRecipeLimit(cause)) return { error, code: cause.code }
    return { error }
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
    refresh()
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
    refresh()
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
    refresh()
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
    refresh()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save recipe costing.") }
  }
}

export async function updateRecipeStatus(
  recipeId: string,
  status: RecipeStatus
): Promise<{ ok: true } | { error: string }> {
  const parsed = z
    .object({ recipeId: z.string().min(1), status: z.enum(RECIPE_STATUSES) })
    .safeParse({ recipeId, status })
  if (!parsed.success) return { error: "Unknown recipe status." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "update-recipe-status",
      parsed.data
    )
    revalidateRecipeReads()
    refresh()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t update the recipe status."),
    }
  }
}
