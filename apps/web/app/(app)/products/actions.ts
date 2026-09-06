"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionErrorMessage } from "@/lib/backend/action-error"
import { djangoAction } from "@/lib/backend/client"
import { getSalesIdentityLines } from "@/lib/backend/queries"
import type { BrowseResult } from "@/lib/backend/pagination"
import type {
  SalesIdentityLine,
  SalesIgnoreRuleMatch,
  SalesIgnoreRuleRow,
  SalesInterpretationReceipt,
} from "@/lib/backend/types"
import { PRODUCT_UNIT_SLUGS } from "@/lib/unit-registry"

const channelSchema = z.enum(["square", "shopify"])
const identityKindSchema = z.enum(["item", "modifier"])
/** Mirrors the database rule: units per sale is a positive decimal ≤ 1M. */
const multiplierSchema = z.number().positive().max(1_000_000)
/** Null while the merchant has not said how much of the sale counts. */
const attributionPercentSchema = z.number().int().min(0).max(100).nullable()

/** Public product refs are URL-safe; UUIDs remain valid for legacy writes. */
const salesProductRefSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^prd_[0-9abcdefghjkmnpqrstvwxyz]{12}$/),
])

const productComponentInputSchema = z
  .object({
    recipeId: z.string().uuid().nullable(),
    ingredientId: z.string().uuid().nullable(),
    productId: z.string().uuid().nullable(),
    quantity: z.number().positive().max(1_000_000),
    unit: z.string().trim().max(32),
    position: z.number().int().min(0),
  })
  .strict()
  .superRefine((component, context) => {
    const targets = [
      component.recipeId,
      component.ingredientId,
      component.productId,
    ].filter((id) => id !== null)
    if (targets.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A component needs exactly one recipe, product or ingredient.",
      })
    }
    if (component.recipeId !== null && component.unit !== "") {
      context.addIssue({
        code: "custom",
        message: "Recipe components do not use a unit.",
      })
    }
    if (component.ingredientId !== null && component.unit === "") {
      context.addIssue({
        code: "custom",
        message: "Ingredient components need a unit.",
      })
    }
    if (component.productId !== null && component.unit !== "") {
      context.addIssue({
        code: "custom",
        message: "Product components do not use a unit.",
      })
    }
    // A box holds three mooncakes, never 2.5 of them.
    if (component.productId !== null && !Number.isInteger(component.quantity)) {
      context.addIssue({
        code: "custom",
        message: "A product component needs a whole number of units.",
      })
    }
  })

const salesProductPatchSchema = z
  .object({
    /** Null creates the product; an existing one is named by its public id. */
    id: salesProductRefSchema.nullable(),
    /** A create has no version to guard, so only an edit carries one. */
    expectedEditVersion: z.number().int().min(0).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    /** Replace-all, like components. An empty list clears every SKU. */
    skus: z
      .array(
        z
          .object({
            sku: z.string().trim().min(1).max(120),
            quantityMultiplier: multiplierSchema,
          })
          .strict()
      )
      .max(20)
      .optional(),
    description: z.string().trim().max(4000).optional(),
    category: z.string().trim().max(120).optional(),
    sellPriceCents: z.number().int().min(0).max(100_000_000).optional(),
    // Blank is "each"; the backend action is the authority on the rest of the
    // list, so a slug this client does not know still fails there.
    baseUnit: z.union([z.literal(""), z.enum(PRODUCT_UNIT_SLUGS)]).optional(),
    isActive: z.boolean().optional(),
    components: z.array(productComponentInputSchema).max(100).optional(),
  })
  .strict()
  .refine(
    (input) =>
      [
        input.name,
        input.skus,
        input.description,
        input.category,
        input.sellPriceCents,
        input.baseUnit,
        input.isActive,
        input.components,
      ].some((value) => value !== undefined),
    { message: "Choose a product field to save." }
  )
  .refine(
    (input) => input.id === null || input.expectedEditVersion !== undefined,
    { message: "Edit version is required." }
  )

export type SaveSalesProductInput = z.input<typeof salesProductPatchSchema>

export type SaveSalesProductResult = {
  id: string
  publicId: string
  editVersion: number
}

/**
 * The product screen's one write, creating and editing through the same
 * fields: a null id makes the product, and any other saves scalar patches
 * against its edit version. The catalog dialog below still owns complete
 * variant/recipe replacement. The backend action contract keeps scalar fields
 * and the optional full-replacement `components` list flat beside the identity
 * and version guard.
 */
export async function saveSalesProduct(
  input: SaveSalesProductInput
): Promise<
  | SaveSalesProductResult
  | { error: string; code?: string; editVersion?: number }
> {
  const parsed = salesProductPatchSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? "Product details look malformed.",
    }
  }
  try {
    const result = await djangoAction<SaveSalesProductResult>(
      "save-sales-product",
      parsed.data
    )
    revalidateSales()
    revalidatePath(`/products/${result.publicId}`)
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save that product.") }
  }
}

const recordManualSalesSchema = z
  .object({
    productId: salesProductRefSchema,
    soldOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
    /** Zero removes the manual entry for this product and date. */
    quantity: z.number().finite().min(0).max(1_000_000),
    totalNetCents: z.number().int().min(0).max(100_000_000).optional(),
  })
  .strict()

export type RecordManualSalesInput = z.input<typeof recordManualSalesSchema>

export type RecordManualSalesResult = {
  ok: boolean
  id?: string | null
  importId: string | null
  productId: string
  publicId: string
  soldOn: string
  deleted: boolean
  quantity?: number
  grossCents?: number
  netSalesCents?: number
  netProvided?: boolean
  currencyCode?: string
  monthTotals?: {
    lineCount: number
    quantity: number
    grossCents: number
    netSalesCents: number
    currencyCode: string | null
  }
}

/** Record (or remove with quantity 0) one product's manual daily sale. */
export async function recordManualSales(
  input: RecordManualSalesInput
): Promise<RecordManualSalesResult | { error: string; code?: string }> {
  const parsed = recordManualSalesSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Manual sale details look malformed.",
    }
  }
  try {
    const result = await djangoAction<RecordManualSalesResult>(
      "record-manual-sales",
      parsed.data
    )
    const productRef = result.publicId || input.productId
    revalidateSales()
    revalidatePath(`/products/${productRef}`)
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t record that manual sale."),
    }
  }
}

const variantSchema = z.object({
  id: z.string().uuid().nullable(),
  sku: z.string().trim().max(120),
  channel: channelSchema.optional(),
  providerAccountId: z.string().trim().max(192).optional(),
  matchKey: z.string().trim().max(500).optional(),
  externalName: z.string().trim().max(240).optional(),
  externalVariantTitle: z.string().trim().max(200).optional(),
  identityKind: identityKindSchema.optional(),
  externalObjectId: z.string().trim().max(192).optional(),
  productExternalObjectId: z.string().trim().max(192).optional(),
  quantityMultiplier: multiplierSchema.optional(),
  attributionPercent: attributionPercentSchema.optional(),
})

const menuItemSchema = z
  .object({
    id: z.string().uuid().nullable(),
    expectedEditVersion: z.number().int().min(0).optional(),
    name: z.string().trim().min(1, "Enter a product name.").max(200),
    isActive: z.boolean(),
    sellPriceCents: z.number().int().min(0).max(100_000_000).optional(),
    components: z.array(productComponentInputSchema).max(100).optional(),
    recipeLinks: z
      .array(
        z.object({
          recipeId: z.string().uuid(),
          quantity: z.number().positive().max(1_000_000),
        })
      )
      .max(50),
    variants: z.array(variantSchema).max(50).optional(),
  })
  .superRefine((item, context) => {
    if (item.id !== null && item.expectedEditVersion === undefined) {
      context.addIssue({ code: "custom", message: "Edit version is required." })
    }
  })

export type MenuItemInput = z.input<typeof menuItemSchema>

export type SaveMenuItemResult = SalesInterpretationReceipt & {
  id: string | null
  /** The saved product's browser identity, so a create can navigate to it. */
  publicId: string
  variantId?: string
  claimedLines: number
}

export async function saveMenuItem(
  input: MenuItemInput
): Promise<SaveMenuItemResult | { error: string }> {
  const parsed = menuItemSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      error: issue?.message.startsWith("Invalid")
        ? "Product details look malformed."
        : (issue?.message ?? "Product details look malformed."),
    }
  }
  try {
    const result = await djangoAction<SaveMenuItemResult>(
      "save-sales-product",
      parsed.data
    )
    revalidateSales()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save that product.") }
  }
}

const ignoreItemSchema = z.object({
  channel: z.enum(["square", "shopify"]),
  providerAccountId: z.string().max(192),
  matchKey: z.string().min(1).max(500),
  sku: z.string().max(120),
  externalName: z.string().max(240),
  externalVariantTitle: z.string().max(200),
})

export type SalesSkuIgnoreInput = z.input<typeof ignoreItemSchema>

export async function ignoreSalesSkus(
  items: SalesSkuIgnoreInput[]
): Promise<{ ignored: number } | { error: string }> {
  const parsed = z.array(ignoreItemSchema).min(1).max(500).safeParse(items)
  if (!parsed.success) return { error: "SKU list looks malformed." }
  try {
    const result = await djangoAction<{ ignored: number }>(
      "ignore-sales-skus",
      { items: parsed.data }
    )
    revalidateReviewTriage()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t ignore those SKUs.") }
  }
}

/** "" is a real bucket — the POS category nobody set — so it stays legal. */
const ignoreCategorySchema = z.object({
  channel: channelSchema,
  providerAccountIds: z.array(z.string().max(192)).min(1).max(100),
  category: z.string().max(120),
  soldOnly: z.boolean().optional(),
})

export type SalesCategoryIgnoreInput = z.input<typeof ignoreCategorySchema>

export type SalesCategoryIgnoreResult = {
  ignoredKeys: number
  ignoredLines: number
  /** Keys a variant already claims; skipped quietly rather than refused. */
  skippedTracked: number
}

/**
 * Sweeps every pending identity in one displayed POS category/type across its
 * provider connections, including rows the capped review payload never sent.
 */
export async function ignoreSalesCategory(
  input: SalesCategoryIgnoreInput
): Promise<SalesCategoryIgnoreResult | { error: string }> {
  const parsed = ignoreCategorySchema.safeParse(input)
  if (!parsed.success) return { error: "Category looks malformed." }
  try {
    const result = await djangoAction<SalesCategoryIgnoreResult>(
      "ignore-sales-category",
      parsed.data
    )
    revalidateReviewTriage()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t ignore that category."),
    }
  }
}

const identityLinesSchema = z.object({
  channel: channelSchema,
  providerAccountId: z.string().max(192),
  matchKey: z.string().min(1).max(500),
})

/**
 * A read behind the action seam: the Catalog rows live in a client component,
 * so the detail dialog fetches its lines through here on open.
 */
export async function salesIdentityLines(input: {
  channel: "square" | "shopify"
  providerAccountId: string
  matchKey: string
}): Promise<
  { items: SalesIdentityLine[]; lineCount: number } | { error: string }
> {
  const parsed = identityLinesSchema.safeParse(input)
  if (!parsed.success) return { error: "That item looks malformed." }
  try {
    return await getSalesIdentityLines(parsed.data)
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t load those sales.") }
  }
}

const unignoreItemSchema = z.object({
  channel: z.enum(["square", "shopify"]),
  providerAccountId: z.string().max(192),
  matchKey: z.string().min(1).max(500),
})

export type SalesSkuUnignoreInput = z.input<typeof unignoreItemSchema>

export async function unignoreSalesSkus(
  items: SalesSkuUnignoreInput[]
): Promise<{ removed: number } | { error: string }> {
  const parsed = z.array(unignoreItemSchema).min(1).max(500).safeParse(items)
  if (!parsed.success) return { error: "SKU list looks malformed." }
  try {
    const result = await djangoAction<{ removed: number }>(
      "unignore-sales-skus",
      { items: parsed.data }
    )
    revalidateReviewTriage()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t restore those SKUs.") }
  }
}

/** Mirrors the limits in `parse_ignore_rule_conditions`. */
const ruleConditionSchema = z.object({
  field: z.enum(["sku", "title", "variant"]),
  operator: z.enum(["is", "starts_with", "contains"]),
  value: z.string().trim().min(1).max(200),
})

const ruleConditionsSchema = z.array(ruleConditionSchema).min(1).max(5)

export type SalesIgnoreRuleConditionInput = z.input<typeof ruleConditionSchema>

export async function saveIgnoreRule(input: {
  id?: string
  channel: "square" | "shopify" | null
  enabled: boolean
  conditions: SalesIgnoreRuleConditionInput[]
}): Promise<{ rule: SalesIgnoreRuleRow; ignored: number } | { error: string }> {
  const parsed = z
    .object({
      id: z.string().uuid().optional(),
      channel: channelSchema.nullable(),
      enabled: z.boolean(),
      conditions: ruleConditionsSchema,
    })
    .safeParse(input)
  if (!parsed.success) return { error: "Add at least one complete condition." }
  try {
    const result = await djangoAction<{
      rule: SalesIgnoreRuleRow
      ignored: number
    }>("save-sales-ignore-rule", parsed.data)
    revalidateRules()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save that rule.") }
  }
}

export async function deleteIgnoreRule(
  id: string
): Promise<{ restored: number } | { error: string }> {
  const parsed = z.string().uuid().safeParse(id)
  if (!parsed.success) return { error: "That rule could not be found." }
  try {
    const result = await djangoAction<{ restored: number }>(
      "delete-sales-ignore-rule",
      { id: parsed.data }
    )
    revalidateRules()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete that rule.") }
  }
}

export async function previewIgnoreRule(input: {
  channel: "square" | "shopify" | null
  conditions: SalesIgnoreRuleConditionInput[]
  page?: number
  q?: string
}): Promise<
  | (BrowseResult<SalesIgnoreRuleMatch> & { truncated: boolean })
  | { error: string }
> {
  const parsed = z
    .object({
      channel: channelSchema.nullable(),
      conditions: ruleConditionsSchema,
      page: z.number().int().min(1).max(1_000_000).optional(),
      q: z.string().trim().max(200).optional(),
    })
    .safeParse(input)
  if (!parsed.success) return { error: "Add at least one complete condition." }
  try {
    return await djangoAction<
      BrowseResult<SalesIgnoreRuleMatch> & { truncated: boolean }
    >("preview-sales-ignore-rule", parsed.data)
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t list the matching products."),
    }
  }
}

/**
 * Interpretation changes (tracking, deleting, remapping) reshape the products
 * table and every mapping tab, so they all go stale together.
 */
function revalidateSales() {
  revalidatePath("/products")
  revalidatePath("/integrations/sales/mapping/modifiers")
  revalidatePath("/integrations/sales/mapping/ignored")
  revalidatePath("/integrations/sales/mapping")
}

/** A rule moves rows between the review queue and Ignored, and lists itself. */
function revalidateRules() {
  revalidatePath("/integrations/sales/mapping/rules")
  revalidateReviewTriage()
}

/**
 * Ignoring or restoring unlinked SKUs only moves rows between the review
 * queue and the Ignored tab. The products and modifiers tables never
 * contained those rows.
 */
function revalidateReviewTriage() {
  revalidatePath("/integrations/sales/mapping/ignored")
  revalidatePath("/integrations/sales/mapping")
}

const modifierOptionAssociationSchema = z.object({
  optionId: z.string().uuid(),
  productId: z.string().uuid().nullable(),
})

const modifierRecordDecisionSchema = z
  .object({
    providerAccountId: z.string().max(192),
    matchKey: z.string().min(1).max(500),
    externalName: z.string().trim().min(1).max(240),
    decision: z.enum(["associate", "unassociate", "ignore"]),
    productId: z.string().uuid().nullable(),
  })
  .refine(
    (row) =>
      row.decision === "associate"
        ? row.productId !== null
        : row.productId === null,
    { message: "Modifier decision and product do not match." }
  )

const groupedModifierAssociationSchema = z
  .object({
    options: z.array(modifierOptionAssociationSchema).max(500),
    records: z.array(modifierRecordDecisionSchema).max(500),
  })
  .refine((value) => value.options.length > 0 || value.records.length > 0, {
    message: "Choose at least one modifier association.",
  })

export type GroupedModifierAssociationInput = z.input<
  typeof groupedModifierAssociationSchema
>

export async function saveSalesModifierAssociations(
  input: GroupedModifierAssociationInput
): Promise<
  | (SalesInterpretationReceipt & {
      variantIds: string[]
      mapped: number
      unmapped: number
      associatedRecords: number
      unassociatedRecords: number
      ignoredRecords: number
    })
  | { error: string }
> {
  const parsed = groupedModifierAssociationSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Modifier associations look malformed.",
    }
  }
  try {
    const result = await djangoAction<
      SalesInterpretationReceipt & {
        variantIds: string[]
        mapped: number
        unmapped: number
        associatedRecords: number
        unassociatedRecords: number
        ignoredRecords: number
      }
    >("save-sales-modifier-associations", parsed.data)
    revalidateSales()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t save modifier associations."),
    }
  }
}

export async function unignoreSalesModifiers(
  items: SalesSkuUnignoreInput[]
): Promise<
  (SalesInterpretationReceipt & { removed: number }) | { error: string }
> {
  const parsed = z.array(unignoreItemSchema).min(1).max(500).safeParse(items)
  if (!parsed.success) return { error: "Modifier list looks malformed." }
  try {
    const result = await djangoAction<
      SalesInterpretationReceipt & { removed: number }
    >("unignore-sales-modifiers", { items: parsed.data })
    revalidateSales()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t restore those modifiers."),
    }
  }
}

export async function setSalesVariantAttribution(
  variantId: string,
  attributionPercent: number | null
): Promise<
  (SalesInterpretationReceipt & { variantId: string }) | { error: string }
> {
  const parsed = z
    .object({
      variantId: z.string().uuid(),
      attributionPercent: attributionPercentSchema,
    })
    .safeParse({ variantId, attributionPercent })
  if (!parsed.success) return { error: "That attribution looks malformed." }
  try {
    const result = await djangoAction<
      SalesInterpretationReceipt & { variantId: string }
    >("update-sales-variant-attribution", parsed.data)
    revalidateSales()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t save that attribution."),
    }
  }
}

/** Detach a variant: its sales go back to Review to be linked elsewhere. */
export async function untrackSalesVariant(
  variantId: string
): Promise<{ variantId: string } | { error: string }> {
  const parsed = z.string().uuid().safeParse(variantId)
  if (!parsed.success) return { error: "That variant looks malformed." }
  try {
    const result = await djangoAction<{ variantId: string }>(
      "untrack-sales-variant",
      { variantId: parsed.data }
    )
    revalidateSales()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t untrack that variant."),
    }
  }
}

export async function deleteMenuItem(
  id: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.string().uuid().safeParse(id)
  if (!parsed.success) return { error: "Product id looks malformed." }
  try {
    await djangoAction("delete-sales-product", { id: parsed.data })
    revalidateSales()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete that product.") }
  }
}
