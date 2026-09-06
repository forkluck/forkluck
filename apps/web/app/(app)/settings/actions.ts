"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireUser } from "@/lib/auth-session"
import type { BusinessSettings, CurrencyCode } from "@/lib/business-settings"
import { actionErrorMessage } from "@/lib/backend/action-error"
import { djangoAction } from "@/lib/backend/client"
import {
  getIngredientCategories,
  getIngredientImports,
  getInvoiceSuppliers,
  getKitchenMembers,
  getPaymentMethods,
  getRecipeCategories,
  listActivity,
} from "@/lib/backend/queries"
import {
  activityEventKindSchema,
  activityResourceTypeSchema,
  kitchenMembersPayloadSchema,
  supplierSummarySchema,
} from "@/lib/backend/schemas"
import type { ActivityPayload, IngredientImportRow } from "@/lib/backend/types"

const nameSchema = z.string().trim().min(1).max(150)
const businessSettingsSchema = z.object({
  wagePerHourCents: z.number().int().min(0).max(100_000_000),
  measurementSystem: z.enum(["metric", "us"]),
  currencyCode: z.enum(["USD", "EUR", "GBP", "CAD"]),
  labelRegion: z.enum(["us", "eu"]),
  timezone: z.string().trim().min(1).max(64),
  foodCostTarget: z.number().min(0.01).max(1),
  overtimeWeeklyMinutes: z.number().int().min(60).max(10080),
  payrollTaxPercent: z.number().min(0).max(200),
  unpaidBreakMinutes: z.number().int().min(0).max(480),
  unpaidBreakPerHours: z.number().int().min(1).max(24),
  expectedCurrencyCode: z.enum(["USD", "EUR", "GBP", "CAD"]),
  confirmCurrencyConversion: z.boolean().optional(),
  quotedRate: z.string().optional(),
  quotedRateDate: z.iso.date().optional(),
})

const currencyQuoteSchema = z.object({
  targetCurrency: z.enum(["USD", "EUR", "GBP", "CAD"]),
  expectedCurrencyCode: z.enum(["USD", "EUR", "GBP", "CAD"]),
})

export type CurrencyConversionQuote = {
  sourceCurrency: CurrencyCode
  targetCurrency: CurrencyCode
  rate: string
  rateDate: string
  provider: string
}

export type SupplierSummary = z.infer<typeof supplierSummarySchema>

/**
 * The workspace's suppliers with their contact details and what points at
 * them. Names, counts and ordering all come from Django in one aggregate;
 * this used to download every ingredient — each carrying its full price
 * history and supplier items — only to count them in JavaScript.
 */
export async function listSuppliers(): Promise<SupplierSummary[]> {
  await requireUser()
  return getInvoiceSuppliers()
}

const supplierInputSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(64).optional(),
  accountNumber: z.string().trim().max(64).optional(),
  notes: z.string().trim().max(2000).optional(),
  // What this supplier's lines are filed under when no line of their own
  // remembers a category. Null clears it.
  defaultCategoryId: z.uuid().nullable().optional(),
})

export type SupplierInput = z.infer<typeof supplierInputSchema>

/** A supplier's name keys its invoices, packs and skip-list rows, so an edit
 * here moves rows the invoices and pantry browses read. */
function revalidateSupplierReads() {
  revalidatePath("/invoices")
  revalidatePath("/ingredients")
  revalidatePath("/settings")
}

export async function saveSupplier(
  input: SupplierInput
): Promise<{ ok: true } | { error: string }> {
  const parsed = supplierInputSchema.safeParse(input)
  if (!parsed.success) return { error: "Enter a name of up to 120 characters." }
  try {
    await djangoAction("save-supplier", parsed.data)
    revalidateSupplierReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save the supplier.") }
  }
}

export async function mergeSuppliers(
  sourceId: string,
  targetId: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z
    .object({ sourceId: z.uuid(), targetId: z.uuid() })
    .safeParse({ sourceId, targetId })
  if (!parsed.success) return { error: "Unknown supplier." }
  try {
    await djangoAction("merge-suppliers", parsed.data)
    revalidateSupplierReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t merge the suppliers.") }
  }
}

export async function deleteSupplier(
  id: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) return { error: "Unknown supplier." }
  try {
    await djangoAction("delete-supplier", { id: parsed.data })
    revalidateSupplierReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete the supplier.") }
  }
}

/** The mapping table rewrites the memory the next invoice reads, so its edits
 *  move the same rows a supplier rename does, plus the table itself. */
function revalidateSupplierItemReads() {
  revalidateSupplierReads()
  revalidatePath("/integrations/suppliers/mapping")
}

const supplierItemIdSchema = z.object({ itemId: z.uuid() })

/** Point one remembered pack at a different ingredient. No price is written,
 *  so this joins no import batch and there is nothing to undo. */
export async function relinkSupplierItem(
  itemId: string,
  ingredientId: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z
    .object({ itemId: z.uuid(), ingredientId: z.uuid() })
    .safeParse({ itemId, ingredientId })
  if (!parsed.success) return { error: "Unknown supplier item." }
  try {
    await djangoAction("relink-supplier-item", parsed.data)
    revalidateSupplierItemReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t change that match.") }
  }
}

export async function ignoreSupplierItem(
  itemId: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = supplierItemIdSchema.safeParse({ itemId })
  if (!parsed.success) return { error: "Unknown supplier item." }
  try {
    await djangoAction("ignore-supplier-item", parsed.data)
    revalidateSupplierItemReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t ignore that item.") }
  }
}

export async function unignoreSupplierItem(
  supplier: string,
  externalId: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z
    .object({
      supplier: z.string().trim().min(1).max(64),
      externalId: z.string().trim().min(1).max(120),
    })
    .safeParse({ supplier, externalId })
  if (!parsed.success) return { error: "Unknown supplier item." }
  try {
    await djangoAction("unignore-supplier-item", parsed.data)
    revalidateSupplierItemReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t restore that item.") }
  }
}

export async function deleteSupplierItem(
  itemId: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = supplierItemIdSchema.safeParse({ itemId })
  if (!parsed.success) return { error: "Unknown supplier item." }
  try {
    await djangoAction("delete-supplier-item", parsed.data)
    revalidateSupplierItemReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete that item.") }
  }
}

export type CategoryKind = "recipe" | "ingredient"

export type CategorySummary = {
  id: string
  name: string
  /** Recipes or ingredients filed under it, this workspace only. */
  count: number
}

const categoryKindSchema = z.enum(["recipe", "ingredient"])
const categoryNameSchema = z.string().trim().min(1).max(64)

/** A category rename or delete moves rows the browses and the dashboard read. */
function revalidateCategoryReads() {
  revalidatePath("/")
  revalidatePath("/recipes")
  revalidatePath("/ingredients")
}

export async function listCategories(
  kind: CategoryKind
): Promise<CategorySummary[]> {
  await requireUser()
  return categoryKindSchema.parse(kind) === "recipe"
    ? getRecipeCategories()
    : getIngredientCategories()
}

export async function renameCategory(
  kind: CategoryKind,
  currentName: string,
  name: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z
    .object({
      kind: categoryKindSchema,
      currentName: categoryNameSchema,
      name: categoryNameSchema,
    })
    .safeParse({ kind, currentName, name })
  if (!parsed.success) return { error: "Enter a name of up to 64 characters." }
  try {
    await djangoAction(`rename-${parsed.data.kind}-category`, {
      currentName: parsed.data.currentName,
      name: parsed.data.name,
    })
    revalidateCategoryReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t rename the category.") }
  }
}

export async function deleteCategory(
  kind: CategoryKind,
  name: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z
    .object({ kind: categoryKindSchema, name: categoryNameSchema })
    .safeParse({ kind, name })
  if (!parsed.success) return { error: "Unknown category." }
  try {
    await djangoAction(`delete-${parsed.data.kind}-category`, {
      name: parsed.data.name,
    })
    revalidateCategoryReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete the category.") }
  }
}

const expenseCategoryInputSchema = z.object({
  id: z.uuid().optional(),
  name: categoryNameSchema,
  /** A supply category buys what the kitchen doesn't eat; it is costable, and
   *  an item its lines create is a supply. */
  isSupply: z.boolean().optional(),
})

/** An expense category labels invoice lines, so the invoices screen re-reads. */
function revalidateExpenseCategoryReads() {
  revalidatePath("/invoices")
  revalidatePath("/settings")
}

export async function saveExpenseCategory(
  input: z.input<typeof expenseCategoryInputSchema>
): Promise<{ ok: true } | { error: string }> {
  const parsed = expenseCategoryInputSchema.safeParse(input)
  if (!parsed.success) return { error: "Enter a name of up to 64 characters." }
  try {
    await djangoAction("save-expense-category", parsed.data)
    revalidateExpenseCategoryReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save the category.") }
  }
}

export async function deleteExpenseCategory(
  id: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) return { error: "Unknown category." }
  try {
    await djangoAction("delete-expense-category", { id: parsed.data })
    revalidateExpenseCategoryReads()
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete the category.") }
  }
}

export type PaymentMethodSummary = { id: string; name: string }

const paymentMethodInputSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(64),
})

/** A method's name is what invoices store, so the invoices screen re-reads. */
function revalidatePaymentMethodReads() {
  revalidatePath("/invoices")
  revalidatePath("/settings")
}

export async function listPaymentMethods(): Promise<PaymentMethodSummary[]> {
  await requireUser()
  return getPaymentMethods()
}

export async function savePaymentMethod(
  input: z.input<typeof paymentMethodInputSchema>
): Promise<{ ok: true } | { error: string }> {
  const parsed = paymentMethodInputSchema.safeParse(input)
  if (!parsed.success) return { error: "Enter a name of up to 64 characters." }
  try {
    await djangoAction("save-payment-method", parsed.data)
    revalidatePaymentMethodReads()
    return { ok: true }
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t save the payment method."),
    }
  }
}

export async function deletePaymentMethod(
  id: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) return { error: "Unknown payment method." }
  try {
    await djangoAction("delete-payment-method", { id: parsed.data })
    revalidatePaymentMethodReads()
    return { ok: true }
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t delete the payment method."),
    }
  }
}

export type KitchenMembersPayload = z.infer<typeof kitchenMembersPayloadSchema>

/**
 * Who else can open this kitchen's recipe book: the members, and the invites
 * still waiting on an address to hold an account. Owner-only, like the rest
 * of settings — a member reaches their own empty tenant here.
 */
export async function listKitchenMembers(): Promise<KitchenMembersPayload> {
  await requireUser()
  return getKitchenMembers()
}

const kitchenRoleSchema = z.enum(["viewer", "editor"])

const kitchenInviteSchema = z.object({
  email: z.string().trim().email(),
  role: kitchenRoleSchema,
})

export async function inviteKitchenMember(input: {
  email: string
  role: "viewer" | "editor"
}): Promise<{ ok: true; invited: boolean } | { error: string }> {
  const parsed = kitchenInviteSchema.safeParse(input)
  if (!parsed.success) return { error: "Enter a valid email address." }
  try {
    // An address with no verified account gets an invite row instead of a
    // membership, and the dialog says so.
    const result = await djangoAction<{ invite?: { id: string } }>(
      "invite-kitchen-member",
      parsed.data
    )
    revalidatePath("/settings")
    return { ok: true, invited: Boolean(result?.invite) }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t send the invite.") }
  }
}

/** `memberId` is the member's account, not the membership row. */
export async function updateKitchenMember(input: {
  memberId: string
  role: "viewer" | "editor"
}): Promise<{ ok: true } | { error: string }> {
  const parsed = z
    .object({ memberId: z.uuid(), role: kitchenRoleSchema })
    .safeParse(input)
  if (!parsed.success) return { error: "Unknown member." }
  try {
    await djangoAction("update-kitchen-member", parsed.data)
    revalidatePath("/settings")
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t change the role.") }
  }
}

export async function removeKitchenMember(input: {
  membershipId: string
}): Promise<{ ok: true } | { error: string }> {
  const parsed = z.object({ membershipId: z.uuid() }).safeParse(input)
  if (!parsed.success) return { error: "Unknown member." }
  try {
    await djangoAction("remove-kitchen-member", parsed.data)
    revalidatePath("/settings")
    return { ok: true }
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t remove the member."),
    }
  }
}

export async function removeKitchenInvite(input: {
  inviteId: string
}): Promise<{ ok: true } | { error: string }> {
  const parsed = z.object({ inviteId: z.uuid() }).safeParse(input)
  if (!parsed.success) return { error: "Unknown invite." }
  try {
    await djangoAction("remove-kitchen-invite", parsed.data)
    revalidatePath("/settings")
    return { ok: true }
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t revoke the invite."),
    }
  }
}

/**
 * The other direction of the same row: a member giving up a kitchen they were
 * let into. The sidebar reads the memberships off the session, so the whole
 * layout is stale the moment this returns.
 */
export async function leaveKitchen(input: {
  membershipId: string
}): Promise<{ ok: true } | { error: string }> {
  const parsed = z.object({ membershipId: z.uuid() }).safeParse(input)
  if (!parsed.success) return { error: "Unknown kitchen." }
  try {
    await djangoAction("remove-kitchen-member", parsed.data)
    revalidatePath("/", "layout")
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t leave the kitchen.") }
  }
}

export async function updateAccountName(
  name: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = nameSchema.safeParse(name)
  if (!parsed.success) return { error: "Enter a name of up to 150 characters." }
  try {
    await djangoAction("update-account", { name: parsed.data })
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save your name.") }
  }
}

/** Ghost owns the subscription, so the row re-reads it after the write. */
export async function setNewsletter(
  enabled: boolean
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.boolean().safeParse(enabled)
  if (!parsed.success) return { error: "Unknown preference." }
  try {
    await djangoAction("set-newsletter", { enabled: parsed.data })
    revalidatePath("/settings")
    return { ok: true }
  } catch (cause) {
    return {
      error: actionErrorMessage(
        cause,
        "Couldn’t update your newsletter preference."
      ),
    }
  }
}

export async function updateBusinessSettings(
  // Product matching is written by setProductMatching, not here: flipping it
  // links or withdraws catalog rows, which is not something a defaults save
  // should do as a side effect. The payroll average is read from payroll.
  input: Omit<
    BusinessSettings,
    "productMatching" | "payrollAverageRateCents"
  > & {
    expectedCurrencyCode: CurrencyCode
    confirmCurrencyConversion?: boolean
    quotedRate?: string
    quotedRateDate?: string
  }
): Promise<{ ok: true } | { error: string }> {
  const parsed = businessSettingsSchema.safeParse(input)
  if (!parsed.success) return { error: "Check the values and try again." }
  try {
    await djangoAction("update-business-settings", parsed.data)
    // The break rule re-costs every stored shift and the payroll tax changes
    // what Labor and Analytics load onto them, so both screens are stale the
    // moment this returns.
    revalidatePath("/labor")
    revalidatePath("/settings")
    // The overview dashboard carries the same labor figures.
    revalidatePath("/")
    return { ok: true }
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t save the business defaults."),
    }
  }
}

const shopifyTokenSchema = z.object({
  shopDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/,
      "Enter your .myshopify.com domain"
    ),
  accessToken: z.string().trim().min(10).max(255),
})

const squareSandboxTokenSchema = z.object({
  accessToken: z.string().trim().min(10).max(2048),
})

export async function connectSquareSandboxToken(input: {
  accessToken: string
}): Promise<{ ok: true } | { error: string }> {
  const parsed = squareSandboxTokenSchema.safeParse(input)
  if (!parsed.success) {
    return { error: "Paste the complete Square sandbox access token." }
  }
  try {
    await djangoAction("connect-square-token", parsed.data)
    revalidatePath("/integrations/sales/connections")
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t connect Square.") }
  }
}

export async function connectShopifyToken(input: {
  shopDomain: string
  accessToken: string
}): Promise<{ ok: true } | { error: string }> {
  const parsed = shopifyTokenSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? "Check the store domain and token.",
    }
  }
  try {
    await djangoAction("connect-shopify-token", parsed.data)
    revalidatePath("/integrations/sales/connections")
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t connect Shopify.") }
  }
}

const shopifyCredentialsSchema = z.object({
  shopDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/,
      "Enter your .myshopify.com domain"
    ),
  clientId: z.string().trim().min(10).max(64),
  clientSecret: z.string().trim().min(10).max(255),
})

export async function connectShopifyCredentials(input: {
  shopDomain: string
  clientId: string
  clientSecret: string
}): Promise<{ ok: true } | { error: string }> {
  const parsed = shopifyCredentialsSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Check the store domain, Client ID, and Client secret.",
    }
  }
  try {
    await djangoAction("connect-shopify-credentials", parsed.data)
    revalidatePath("/integrations/sales/connections")
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t connect Shopify.") }
  }
}

export async function disconnectPos(
  provider: "square" | "shopify"
): Promise<{ ok: true; note: string } | { error: string }> {
  const parsed = z.enum(["square", "shopify"]).safeParse(provider)
  if (!parsed.success) return { error: "Unknown channel." }
  try {
    const result = await djangoAction<{ ok: true; note: string }>(
      "disconnect-pos",
      { provider: parsed.data }
    )
    revalidatePath("/integrations/sales/connections")
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t disconnect.") }
  }
}

export async function getCurrencyConversionQuote(
  targetCurrency: CurrencyCode,
  expectedCurrencyCode: CurrencyCode
): Promise<CurrencyConversionQuote> {
  await requireUser()
  const response = await djangoAction<{ quote: CurrencyConversionQuote }>(
    "currency-conversion-quote",
    currencyQuoteSchema.parse({ targetCurrency, expectedCurrencyCode })
  )
  return response.quote
}

const billingCustomerIdSchema = z.string().uuid().optional()

export type BillingPortalChoice = { id: string; label: string }

export async function createBillingPortal(
  customerId?: string
): Promise<
  { url: string } | { customers: BillingPortalChoice[] } | { error: string }
> {
  const parsed = billingCustomerIdSchema.safeParse(customerId)
  if (!parsed.success) return { error: "Billing account is invalid." }
  try {
    return await djangoAction<
      { url: string } | { customers: BillingPortalChoice[] }
    >("create-billing-portal", { customerId: parsed.data })
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t open billing. Try again."),
    }
  }
}

export async function setProductMatching(
  enabled: boolean
): Promise<{ ok: true } | { error: string }> {
  try {
    await djangoAction("set-product-matching", {
      enabled: z.boolean().parse(enabled),
    })
    // Linking rewrites the catalog and what sales attribute to, so every
    // surface that reads a product has to be refetched, not just settings.
    revalidatePath("/settings")
    revalidatePath("/products")
    revalidatePath("/integrations/sales/mapping")
    return { ok: true }
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t change product matching."),
    }
  }
}

const activityParamsSchema = z.object({
  before: z.string().max(64).optional(),
  /** One resource's own history, e.g. everything logged for an invoice. */
  resourceId: z.uuid().optional(),
  events: z.array(activityEventKindSchema).optional(),
  types: z.array(activityResourceTypeSchema).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export type ActivityParams = z.infer<typeof activityParamsSchema>

export async function loadActivity(
  params: ActivityParams = {}
): Promise<ActivityPayload> {
  await requireUser()
  return listActivity(activityParamsSchema.parse(params))
}

/**
 * The purchase-report imports behind the history's "Imported" entries: the
 * log says what an import did, these rows say whether it can still be undone.
 */
export async function loadIngredientImports(): Promise<IngredientImportRow[]> {
  await requireUser()
  return getIngredientImports()
}

/** Every read that could still show a deleted row. */
const KITCHEN_DATA_PATHS = [
  "/",
  "/recipes",
  "/ingredients",
  "/menus",
  "/invoices",
  "/labor",
  "/products",
]

export async function deleteKitchenData(): Promise<
  { ok: true; deleted: Record<string, number> } | { error: string }
> {
  try {
    const result = await djangoAction<{
      ok: true
      deleted: Record<string, number>
    }>("delete-kitchen-data", {})
    for (const path of KITCHEN_DATA_PATHS) revalidatePath(path)
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t delete your kitchen data."),
    }
  }
}

export async function resetGuestLinks(): Promise<
  { ok: true; revoked: number } | { error: string }
> {
  try {
    const result = await djangoAction<{ ok: true; revoked: number }>(
      "reset-guest-links",
      {}
    )
    revalidatePath("/recipes")
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t reset your shared links."),
    }
  }
}
