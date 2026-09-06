"use server"

import { revalidatePath } from "next/cache"
import * as XLSX from "xlsx"
import { z } from "zod"

import { ALLERGEN_KEYS } from "@/lib/nutrition/allergens"
import {
  customNutritionValuesSchema,
  type CustomNutritionValues,
} from "@/lib/nutrition/custom-values"

import { requireUser } from "@/lib/auth-session"
import { actionErrorMessage } from "@/lib/backend/action-error"
import type { IngredientDetail } from "@/lib/backend/types"
import { getIngredient, searchInvoiceLineOptions } from "@/lib/backend/queries"
import { BackendRequestError, djangoAction } from "@/lib/backend/client"
import {
  catalogActivationSchema,
  catalogIngredientsPayloadSchema,
  type CatalogIngredientSuggestion,
} from "@/lib/backend/schemas"
import { parsePurchaseRows, type PurchaseImport } from "@/lib/purchase-import"
import type { PriceListEntry } from "@/lib/pricing"
import type { InvoiceLineOption } from "@/lib/backend/types"
import {
  assertArchiveWithinBudget,
  complexityMessage,
  readFirstSheetRows,
} from "@/lib/import-limits"

/**
 * Revalidating a path already refreshes the current route's RSC payload on
 * the action's response, so none of these actions needs an extra refresh()
 * on top — that was a second full server render per save.
 */
function revalidateIngredientReads() {
  revalidatePath("/")
  revalidatePath("/ingredients")
  revalidatePath("/recipes")
}

export type CatalogPriceSuggestion = PriceListEntry & {
  source: "catalog"
  catalogPriceId: string
  purchaseSize: number
  purchaseUnit: string
}

/** The catalog names its columns after the pack it observed. The pantry names
 * them after the purchase that pack would become. */
type CatalogPricePayload = {
  id: string
  catalogPriceId: string
  name: string
  normalizedName: string
  packPriceCents: number
  packGrams: number | null
  packAmount: number
  packUnit: string
  source: "catalog"
}

/** The usable share after trim. Omitted leaves the saved yield alone. */
const yieldPercentField = z
  .number()
  .gt(0, "Yield must be more than 0% and at most 100%.")
  .max(100, "Yield must be more than 0% and at most 100%.")
  .optional()

const saveIngredientSchema = z.object({
  id: z.string().min(1).nullable(),
  /** Required on a create; omitted on a pack write, which leaves it alone. */
  name: z.string().trim().min(1, "Name is required").max(120).optional(),
  /** The pack, together or not at all: absent leaves the saved one alone. */
  purchaseCostCents: z.number().int().min(0).max(100000000).optional(),
  purchaseSize: z.number().min(0).max(1000000).nullable().optional(),
  purchaseUnit: z.string().trim().max(64).nullable().optional(),
  yieldPercent: yieldPercentField,
  /** The category name. Null clears it; omitted leaves it as saved. */
  category: z.string().trim().max(120).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
  /** True creates a supply; omitted leaves the saved flag alone. */
  nonEdible: z.boolean().optional(),
  /** The whole tag list. Omitted leaves the saved memberships alone. */
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  expectedEditVersion: z.number().int().min(0).optional(),
})

type SavedIngredient = {
  id: string
  publicId: string
  /** What the ingredient is at now, sent back as the next expectation. */
  editVersion: number
}

export async function saveIngredient(
  input: z.input<typeof saveIngredientSchema>
): Promise<
  SavedIngredient | { error: string; code?: string; editVersion?: number }
> {
  const parsed = saveIngredientSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "That input is invalid.",
    }
  }
  try {
    const result = await djangoAction<SavedIngredient>(
      "save-ingredient",
      parsed.data
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    // The form tells a refused stale write apart from every other failure.
    if (cause instanceof BackendRequestError && cause.code === "stale_write") {
      return {
        error: cause.message,
        code: cause.code,
        editVersion: cause.editVersion,
      }
    }
    return { error: actionErrorMessage(cause, "Couldn’t save the ingredient.") }
  }
}

/** Archiving keeps the ingredient and its history; it only drops out of the
 * pickers and the default list. */
export async function archiveIngredient(
  id: string,
  archived: boolean
): Promise<{ item: IngredientDetail } | { error: string }> {
  const parsed = z
    .object({ id: z.string().min(1), archived: z.boolean() })
    .safeParse({ id, archived })
  if (!parsed.success) return { error: "Ingredient id is required." }
  try {
    const result = await djangoAction<{ item: IngredientDetail }>(
      "archive-ingredient",
      parsed.data
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t archive the ingredient."),
    }
  }
}

/** Detail is intentionally loaded only when a browse row opens a dialog. */
export async function loadIngredientDetail(
  publicId: string
): Promise<IngredientDetail | { error: string }> {
  await requireUser()
  const parsed = z.string().min(1).max(64).safeParse(publicId)
  if (!parsed.success) return { error: "Ingredient id is required." }
  try {
    return (
      (await getIngredient(parsed.data)) ?? { error: "Ingredient not found." }
    )
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t load the ingredient.") }
  }
}

export type NutritionFoodMatch = {
  fdcId: number
  description: string
  dataType: string
  /** The brand owner on a branded record; empty on a common food. */
  brand: string
}

export type NutritionSearchScope = "common" | "branded"

export async function searchNutritionFoods(
  query: string,
  scope: NutritionSearchScope = "common"
): Promise<{ items: NutritionFoodMatch[] } | { error: string }> {
  const parsed = z.string().trim().min(2).max(120).safeParse(query)
  if (!parsed.success) return { error: "Enter at least 2 characters." }
  try {
    return await djangoAction("search-nutrition-foods", {
      query: parsed.data,
      scope: z.enum(["common", "branded"]).parse(scope),
    })
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t search nutrition data."),
    }
  }
}

export async function setIngredientNutrition(
  ingredientId: string,
  fdcId: number
): Promise<{ ok: true } | { error: string }> {
  try {
    const result = await djangoAction<{ ok: true }>(
      "set-ingredient-nutrition",
      {
        ingredientId: z.string().uuid().parse(ingredientId),
        fdcId: z.number().int().positive().parse(fdcId),
      }
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save nutrition data.") }
  }
}

export async function clearIngredientNutrition(
  ingredientId: string
): Promise<{ ok: true } | { error: string }> {
  try {
    const result = await djangoAction<{ ok: true }>(
      "clear-ingredient-nutrition",
      { ingredientId: z.string().uuid().parse(ingredientId) }
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t clear nutrition data."),
    }
  }
}

const allergenOverrideSchema = z.object({
  key: z.enum(ALLERGEN_KEYS),
  status: z.enum(["contains", "mayContain", "doesNotContain"]),
})

export async function replaceIngredientAllergens(
  ingredientId: string,
  allergens: Array<z.input<typeof allergenOverrideSchema>>
): Promise<{ ok: true } | { error: string }> {
  const parsed = z
    .object({
      ingredientId: z.string().uuid(),
      allergens: z.array(allergenOverrideSchema).max(ALLERGEN_KEYS.length),
    })
    .safeParse({ ingredientId, allergens })
  if (!parsed.success) return { error: "Allergen values look invalid." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "replace-ingredient-allergens",
      parsed.data
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save allergens.") }
  }
}

const nutritionSettingsSchema = z.object({
  ingredientId: z.string().uuid(),
  nonEdible: z.boolean().optional(),
  sugarsAreAdded: z.boolean().optional(),
  labelName: z.string().trim().max(120).optional(),
})

/** Not food, added sugars and the label name; absent keys are left alone. */
export async function updateIngredientNutritionSettings(
  ingredientId: string,
  settings: {
    nonEdible?: boolean
    sugarsAreAdded?: boolean
    labelName?: string
  }
): Promise<{ ok: true } | { error: string }> {
  const parsed = nutritionSettingsSchema.safeParse({
    ingredientId,
    ...settings,
  })
  if (!parsed.success) return { error: "Nutrition settings look invalid." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "update-ingredient-nutrition-settings",
      parsed.data
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t save nutrition settings."),
    }
  }
}

/** Package values for an ingredient no USDA record matches. Support applies
 * them; the row is the record and the email a notification. */
export async function requestCustomNutrition(
  ingredientId: string,
  request: {
    servingGrams: number
    values: CustomNutritionValues
    source?: string
    note?: string
  }
): Promise<{ id: string; status: string } | { error: string }> {
  const parsed = z
    .object({
      ingredientId: z.string().uuid(),
      servingGrams: z.number().positive().max(100000),
      values: customNutritionValuesSchema,
      source: z.string().trim().max(240).optional(),
      note: z.string().trim().max(2000).optional(),
    })
    .safeParse({ ingredientId, ...request })
  if (!parsed.success) return { error: "Check the values and try again." }
  try {
    const result = await djangoAction<{ id: string; status: string }>(
      "request-custom-nutrition",
      parsed.data
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t send the request.") }
  }
}

export async function saveRecipeLineMatch(
  line: string,
  targetId: string,
  targetKind: "ingredient" | "recipe"
): Promise<{ ok: true } | { error: string }> {
  await requireUser()
  try {
    const result = await djangoAction<{ ok: true }>("save-recipe-line-match", {
      line: z.string().min(1).max(200).parse(line),
      targetId: z.string().min(1).parse(targetId),
      targetKind: z.enum(["ingredient", "recipe"]).parse(targetKind),
    })
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t link that line.") }
  }
}

export async function searchCatalogPrices(
  query: string
): Promise<{ items: CatalogPriceSuggestion[] } | { error: string }> {
  const parsed = z.string().trim().min(3).max(120).safeParse(query)
  if (!parsed.success) return { error: "Enter at least 3 characters." }
  try {
    const { items } = await djangoAction<{ items: CatalogPricePayload[] }>(
      "search-catalog-prices",
      { query: parsed.data }
    )
    return {
      items: items.map((item) => ({
        id: item.id,
        catalogPriceId: item.catalogPriceId,
        name: item.name,
        normalizedName: item.normalizedName,
        source: item.source,
        purchaseCostCents: item.packPriceCents,
        purchaseSize: item.packAmount,
        purchaseUnit: item.packUnit,
      })),
    }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t search Catalog.") }
  }
}

export async function searchCatalogIngredients(
  query: string
): Promise<{ items: CatalogIngredientSuggestion[] } | { error: string }> {
  const parsed = z.string().trim().min(2).max(120).safeParse(query)
  if (!parsed.success) return { error: "Enter at least 2 characters." }
  try {
    return catalogIngredientsPayloadSchema.parse(
      await djangoAction("search-catalog-ingredients", { query: parsed.data })
    )
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t search Catalog.") }
  }
}

export async function activateCatalogIngredient(
  catalogIngredientId: string
): Promise<
  | { id: string; name: string; created: boolean; preparations: string[] }
  | { error: string }
> {
  try {
    const result = catalogActivationSchema.parse(
      await djangoAction("activate-catalog-ingredient", {
        catalogIngredientId: z.string().uuid().parse(catalogIngredientId),
      })
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t add that ingredient."),
    }
  }
}

export async function adoptMasterPrice(
  masterPriceId: string
): Promise<{ id: string; created: boolean } | { error: string }> {
  try {
    return await djangoAction("adopt-master-price", {
      masterPriceId: z.string().uuid().parse(masterPriceId),
    })
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t add that estimate.") }
  }
}

export async function adoptCatalogPrice(
  catalogPriceId: string
): Promise<{ id: string; created: boolean } | { error: string }> {
  try {
    return await djangoAction("adopt-catalog-price", {
      catalogPriceId: z.string().uuid().parse(catalogPriceId),
    })
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t add that Catalog estimate."),
    }
  }
}

export async function dismissMasterPrice(
  masterPriceId: string
): Promise<{ ok: true } | { error: string }> {
  try {
    const result = await djangoAction<{ ok: true }>("dismiss-master-price", {
      masterPriceId: z.string().uuid().parse(masterPriceId),
    })
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t hide that estimate.") }
  }
}

export async function searchInvoiceItems(
  query: string
): Promise<{ items: InvoiceLineOption[] } | { error: string }> {
  await requireUser()
  try {
    return { items: await searchInvoiceLineOptions(query.trim().slice(0, 120)) }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t search invoices.") }
  }
}

const linkPurchaseSchema = z.object({
  purchaseSize: z.number().min(0).max(1000000),
  purchaseUnit: z.string().trim().min(1).max(64),
})

/** Adds an invoice price without changing the ingredient's active costing. */
export async function linkInvoiceItem(
  ingredientId: string,
  lineId: string,
  purchase: z.input<typeof linkPurchaseSchema>
): Promise<{ ok: true; editVersion: number } | { error: string }> {
  const parsed = linkPurchaseSchema.safeParse(purchase)
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "That input is invalid.",
    }
  }
  try {
    const result = await djangoAction<{ ok: true; editVersion: number }>(
      "link-invoice-line",
      {
        ingredientId: z.string().uuid().parse(ingredientId),
        lineId: z.string().uuid().parse(lineId),
        ...parsed.data,
      }
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t connect that invoice item."),
    }
  }
}

export async function disconnectInvoiceItem(
  ingredientId: string,
  invoicePriceId: string
): Promise<{ ok: true; editVersion: number } | { error: string }> {
  try {
    const result = await djangoAction<{ ok: true; editVersion: number }>(
      "disconnect-invoice-line",
      {
        ingredientId: z.string().uuid().parse(ingredientId),
        invoicePriceId: z.string().uuid().parse(invoicePriceId),
      }
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t disconnect that item."),
    }
  }
}

export async function applyInvoicePrice(
  ingredientId: string,
  invoicePriceId: string
): Promise<{ ok: true; editVersion: number } | { error: string }> {
  try {
    const result = await djangoAction<{ ok: true; editVersion: number }>(
      "use-invoice-price",
      {
        ingredientId: z.string().uuid().parse(ingredientId),
        invoicePriceId: z.string().uuid().parse(invoicePriceId),
      }
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t use that invoice price."),
    }
  }
}

const preparationMeasurementSchema = z.object({
  amount: z.number().positive().max(1000000),
  unit: z.string().trim().min(1).max(64),
})

const savePreparationSchema = z
  .object({
    ingredientId: z.string().uuid(),
    id: z.string().uuid().nullable(),
    name: z.string().trim().min(1, "Preparation name is required").max(120),
    yieldPercent: z
      .number()
      .positive("Yield must be greater than zero and at most 1000.")
      .max(1000, "Yield must be greater than zero and at most 1000.")
      .nullable(),
    usesStandardConversion: z.boolean(),
    weight: preparationMeasurementSchema.nullable(),
    volume: preparationMeasurementSchema.nullable(),
    each: preparationMeasurementSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.usesStandardConversion &&
      (value.weight !== null || value.volume !== null || value.each !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Standard preparation conversion cannot include custom measurements.",
      })
    }
  })

export async function savePreparation(
  input: z.input<typeof savePreparationSchema>
): Promise<{ id: string } | { error: string }> {
  const parsed = savePreparationSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "That preparation is invalid.",
    }
  }
  try {
    const result = await djangoAction<{ id: string }>(
      "save-preparation",
      parsed.data
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t save the preparation."),
    }
  }
}

const conversionSchema = z.object({
  ingredientId: z.string().uuid(),
  usesStandardConversion: z.boolean(),
  weight: z
    .object({
      amount: z.number().nonnegative().max(1000000),
      unit: z.string().max(64),
    })
    .nullable(),
  volume: z
    .object({
      amount: z.number().nonnegative().max(1000000),
      unit: z.string().max(64),
    })
    .nullable(),
  each: z
    .object({
      amount: z.number().nonnegative().max(1000000),
      unit: z.string().max(64),
    })
    .nullable(),
})

export async function saveIngredientConversion(
  input: z.input<typeof conversionSchema>
): Promise<{ ok: true } | { error: string }> {
  const parsed = conversionSchema.safeParse(input)
  if (!parsed.success) return { error: "That conversion looks invalid." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "save-ingredient-conversion",
      parsed.data
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t save the conversion."),
    }
  }
}

export async function resetIngredientConversion(
  ingredientId: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.string().uuid().safeParse(ingredientId)
  if (!parsed.success) return { error: "Ingredient id is required." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "reset-ingredient-conversion",
      { ingredientId: parsed.data }
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t reset the conversion."),
    }
  }
}

export async function deletePreparations(ids: string[]): Promise<
  | { ok: true }
  | {
      error: string
      usedInRecipes?: Array<{ id: string; publicId: string; title: string }>
    }
> {
  const parsed = z.array(z.string().uuid()).min(1).max(200).safeParse(ids)
  if (!parsed.success) return { error: "Preparation ids look malformed." }
  try {
    const result = await djangoAction<
      | { ok: true }
      | {
          error: string
          usedInRecipes: Array<{ id: string; publicId: string; title: string }>
        }
    >("delete-preparations", { ids: parsed.data })
    if ("ok" in result) revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t delete those preparations."),
    }
  }
}

export async function deleteIngredient(id: string): Promise<
  | { ok: true }
  | {
      error: string
      usedInRecipes?: Array<{ id: string; publicId: string; title: string }>
    }
> {
  const parsed = z.string().min(1).safeParse(id)
  if (!parsed.success) return { error: "Ingredient id is required." }
  try {
    const result = await djangoAction<
      | { ok: true }
      | {
          error: string
          usedInRecipes: Array<{ id: string; publicId: string; title: string }>
        }
    >("delete-ingredient", { id: parsed.data })
    if ("ok" in result) revalidateIngredientReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t delete the ingredient."),
    }
  }
}

/** Parses an uploaded purchase report (xlsx or csv) into a preview. */
export async function parsePurchaseFile(
  base64: string,
  fileName: string
): Promise<PurchaseImport | { error: string }> {
  await requireUser()
  const raw = z.string().min(1).max(8_000_000).parse(base64)
  const safeFileName = z.string().trim().min(1).max(255).parse(fileName)
  try {
    const bytes = Buffer.from(raw, "base64")
    // Bound the archive from its own directory before SheetJS inflates it.
    assertArchiveWithinBudget(bytes)
    const workbook = XLSX.read(bytes, { type: "buffer" })
    const rows = readFirstSheetRows(workbook, {
      header: 1,
      raw: true,
      defval: "",
    })
    if (!rows) return { error: "The file has no sheets." }
    const result = parsePurchaseRows(rows, { fileName: safeFileName })
    const supplierIds = [
      ...result.entries.map((entry) => entry.externalId),
      ...result.skipped.map((entry) => entry.externalId),
    ].filter((value): value is string => Boolean(value))
    if (result.source && supplierIds.length > 0) {
      const status = await djangoAction<{
        existingIds: string[]
        ignoredIds: string[]
      }>("supplier-import-status", {
        supplier: result.source.supplier,
        externalIds: supplierIds,
      })
      const existingIds = new Set(status.existingIds)
      const ignoredIds = new Set(status.ignoredIds)
      for (const entry of result.entries) {
        entry.status =
          entry.externalId && existingIds.has(entry.externalId)
            ? "update"
            : "new"
      }
      for (const entry of result.skipped) {
        entry.status =
          entry.externalId && ignoredIds.has(entry.externalId)
            ? "ignored"
            : "review"
      }
    }
    return result
  } catch (cause) {
    return {
      error:
        complexityMessage(cause) ??
        "Couldn't read that file — export it as .xlsx or .csv and try again.",
    }
  }
}

const importEntrySchema = z.object({
  supplier: z.string().trim().min(1).max(64).nullable(),
  externalId: z.string().trim().min(1).max(120).nullable(),
  name: z.string().trim().min(1).max(120),
  rawSize: z.string().trim().max(120),
  quantity: z.number().min(0).max(1000000).nullable(),
  packAmount: z.number().positive().max(1000000),
  packUnit: z.string().trim().min(1).max(64),
  packPriceCents: z.number().int().min(1).max(100000000),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  preferred: z.boolean(),
  ingredientId: z.string().uuid().nullable(),
})

const ignoredEntrySchema = z.object({
  supplier: z.string().trim().min(1).max(64),
  externalId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  rawSize: z.string().trim().max(120),
})

const importRequestSchema = z
  .object({
    entries: z.array(importEntrySchema).max(500),
    ignored: z.array(ignoredEntrySchema).max(500),
    fileName: z.string().trim().min(1).max(255),
    source: z
      .object({
        supplier: z.string().trim().min(1).max(64),
        periodStart: z.string().nullable(),
        periodEnd: z.string().nullable(),
      })
      .nullable(),
    totalRows: z.number().int().min(0).max(1000000),
    reviewCount: z.number().int().min(0).max(1000000),
  })
  .refine((value) => value.entries.length + value.ignored.length > 0)

export type ImportReceipt = {
  batchId: string
  imported: number
  created: number
  updated: number
  ignored: number
  review: number
}

export async function importIngredients(
  input: z.input<typeof importRequestSchema>
): Promise<ImportReceipt | { error: string }> {
  await requireUser()
  const parsed = importRequestSchema.safeParse(input)
  if (!parsed.success) return { error: "Import data looks malformed." }
  try {
    const result = await djangoAction<ImportReceipt>(
      "import-ingredients",
      parsed.data
    )
    revalidateIngredientReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t import that file.") }
  }
}

export async function undoIngredientImport(id: string) {
  await requireUser()
  const result = await djangoAction<{
    ok: true
    deletedSupplierItems: number
    restoredSupplierItems: number
    deletedIngredients: number
    retainedIngredients: number
  }>("undo-ingredient-import", { id: z.string().uuid().parse(id) })
  revalidateIngredientReads()
  return result
}

export async function setPreferredSupplierItem(id: string) {
  await requireUser()
  const result = await djangoAction<{ ok: true; editVersion: number }>(
    "set-preferred-supplier-item",
    { id: z.string().uuid().parse(id) }
  )
  revalidateIngredientReads()
  return result
}

export async function mergeIngredients(sourceId: string, targetId: string) {
  await requireUser()
  const ids = z
    .object({ sourceId: z.string().uuid(), targetId: z.string().uuid() })
    .refine((value) => value.sourceId !== value.targetId)
    .parse({ sourceId, targetId })
  const result = await djangoAction<{
    ok: true
    targetId: string
    editVersion: number
  }>("merge-ingredients", ids)
  revalidateIngredientReads()
  return result
}
