import { z } from "zod"

import { MAX_RECIPE_CATEGORY_LENGTH } from "@/lib/recipe/categories"
import { RECIPE_KINDS } from "@/lib/recipe/kinds"
import { RECIPE_STATUSES } from "@/lib/recipe/status"
import { YIELD_UNIT_VALUES } from "@/lib/unit-registry"

/**
 * What the save-recipe action accepts, as the editor and the phone send it.
 * Lives outside the "use server" module so tests (and the fixture the iOS
 * app asserts its encoder against) can import it without Next's runtime.
 */

export const saveRecipeSchema = z.object({
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

export const recipeItemSchema = z.object({
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

export const recipeStepSchema = z.object({
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

export const recipeBatchSchema = z.object({
  label: z.string().max(120),
  scale: z.number().positive().max(1000000),
  isOriginal: z.boolean(),
})

export const recipeEquivalencySchema = z.object({
  massAmount: z.number().positive().nullable(),
  massUnit: z.string().max(32),
  volumeAmount: z.number().positive().nullable(),
  volumeUnit: z.string().max(32),
  countAmount: z.number().positive().nullable(),
  countUnit: z.string().max(32),
  standard: z.boolean(),
})

export const recipeAggregateSchema = saveRecipeSchema.extend({
  items: z.array(recipeItemSchema).max(1000),
  steps: z.array(recipeStepSchema).max(1000),
  batchSizes: z.array(recipeBatchSchema).max(100).optional(),
  equivalency: recipeEquivalencySchema.nullable().optional(),
  // Owner payloads only: a shared editor omitting the key preserves them.
  tags: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  expectedEditVersion: z.number().int().min(0).optional(),
})
