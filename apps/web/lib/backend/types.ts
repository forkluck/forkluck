import type { z } from "zod"
import type { CurrencyCode } from "@/lib/business-settings"

import type {
  ExternalRefKind,
  ExternalRefSystem,
} from "@/lib/recipe/external-refs"
import type {
  driveFilePartSchema,
  driveFileRowSchema,
  driveFilesPayloadSchema,
  driveWatchFolderSchema,
  driveWatchPayloadSchema,
  driveWatchSummarySchema,
  ingredientPriceSchema,
  ingredientCategoriesPayloadSchema,
  ingredientTagSchema,
  ingredientTagsPayloadSchema,
  ingredientSummarySchema,
  ingredientSchema,
  guestBookPayloadSchema,
  guestRecipePayloadSchema,
  netSalesTrendSchema,
  expansionIssueSchema,
  productDetailSchema,
  productDetailSalesSchema,
  menuForecastPayloadSchema,
  pricingEntriesPayloadSchema,
  primoConversationListSchema,
  primoConversationSchema,
  posConnectionSchema,
  posSyncReceiptSchema,
  posSyncRunSchema,
  recipeCostDiffPayloadSchema,
  recipeDetailSchema,
  recipeNutritionSchema,
  allergenHintsSchema,
  recipeNutritionLineSchema,
  nutrientsSchema,
  recipeSummarySchema,
  salesProductVariantSchema,
  salesImportSchema,
  salesOverviewSchema,
  salesProductSchema,
  productComponentSchema,
  dailySalesSchema,
  periodProductSalesSchema,
  searchIndexPayloadSchema,
  supplierItemSchema,
  supplierItemIgnoreRowSchema,
  supplierItemRowSchema,
} from "@/lib/backend/schemas"

export type PrimoConversationList = z.infer<typeof primoConversationListSchema>
export type PrimoConversation = z.infer<typeof primoConversationSchema>["item"]
export type PrimoConversationSummary = PrimoConversation["conversation"]
export type PrimoPersistedMessage = PrimoConversation["messages"][number]

type IngredientWire = z.infer<typeof ingredientSchema>
export type IngredientRow = IngredientWire
export type IngredientSummary = z.infer<typeof ingredientSummarySchema>
export type IngredientDetail = IngredientRow

export type IngredientTagRow = z.infer<typeof ingredientTagSchema>
export type IngredientTagOptionRow = z.infer<
  typeof ingredientTagsPayloadSchema
>["items"][number]
export type IngredientCategoryRow = z.infer<
  typeof ingredientCategoriesPayloadSchema
>["items"][number]
/** Absent means the active pantry; the pantry browse also takes "all". */
export type IngredientBrowseStatus = "active" | "archived" | "all"
/** Absent means food only; "supply" is the packaging list, "all" the union. */
export type IngredientBrowseKind = "food" | "supply" | "all"

export type DashboardOverview = {
  recipeMetrics: {
    averageFoodCost: number | null
    totalRecipes: number
    costedRecipes: number
    recipesNeedingAttention: number
    foodCostTarget: number
  }
  priceMoves: Array<{
    id: string
    name: string
    percent: number
    unitPriceCents: number
    unit: string
  }>
  currencyCode: CurrencyCode
}

export type SearchIndexItem = z.infer<
  typeof searchIndexPayloadSchema
>["items"][number]

export type SupplierItemRow = z.infer<typeof supplierItemSchema>

export type IngredientPriceRow = z.infer<typeof ingredientPriceSchema>

export type IngredientImportRow = {
  id: string
  fileName: string
  supplier: string | null
  periodStart: string | null
  periodEnd: string | null
  totalRows: number
  importedCount: number
  createdCount: number
  updatedCount: number
  reviewCount: number
  ignoredCount: number
  createdAt: Date
  undoneAt: Date | null
  canUndo: boolean
}

export type InvoiceDocumentType =
  "invoice" | "credit_memo" | "receipt" | "refund"

export type ExpenseCategoryRow = {
  id: string
  name: string
  /** Costable: its lines may update supplier packs and pantry prices. */
  isIngredient: boolean
  /** Buys what the kitchen doesn't eat, so a new item under it is a supply. */
  isSupply: boolean
  position: number
}

export type InvoiceRow = {
  id: string
  /** Globally unique URL identifier (Stripe-style, e.g. "inv_k8f3m29qp7vw"). */
  publicId: string
  supplier: string
  supplierName: string
  documentType: InvoiceDocumentType
  invoiceNumber: string
  /** Plain "YYYY-MM-DD" string, like SupplierItemRow.periodStart. */
  invoiceDate: string | null
  /**
   * The currency the supplier billed in, captured at import. An invoice is a
   * third-party record, so a workspace currency change does not restate it —
   * always format `totalCents` with this, never with the workspace currency.
   */
  currencyCode: CurrencyCode
  totalCents: number
  /** Tax already inside totalCents; 0 when the document prints none. */
  taxCents: number
  lineCount: number
  matchedLineCount: number
  unresolvedLineCount: number
  /**
   * Why this row is in the attention tab, worst first, or null when nothing
   * is wrong with it.
   */
  issueKind:
    | "no-lines"
    | "unmatched-lines"
    | "total-mismatch"
    | "unknown-supplier"
    | null
  /** totalCents - the lines - taxCents; null on an unannotated read. */
  totalDeltaCents: number | null
  fileName: string
  /** "connector" for service imports, null for uploaded documents. */
  source: "connector" | null
  driveFileId: string | null
  driveWebViewLink: string | null
  createdAt: Date
  updatedAt: Date
}

export type InvoiceLineRow = {
  id: string
  position: number
  sku: string
  description: string
  quantity: number | null
  unit: string
  packSize: string
  /** Denormalized from the parent invoice; see InvoiceRow.currencyCode. */
  currencyCode: CurrencyCode
  unitPriceCents: number | null
  lineAmountCents: number
  categoryId: string | null
  categoryName: string | null
  ingredientId: string | null
  ingredientName: string | null
  priceUpdated: boolean
  needsReview: boolean
}

/** A built-in wire value, one of the workspace's own method names, or "" when
 *  the merchant did not record how the invoice was paid. */
export type InvoicePaymentMethod = string

/** One invoice read as a whole document, from `invoices/<publicId>/`. */
export type InvoiceDetail = {
  id: string
  publicId: string
  /** The optimistic-concurrency counter a save sends back as its expectation. */
  editVersion: number
  supplier: string
  supplierName: string
  documentType: InvoiceDocumentType
  invoiceNumber: string
  /** Plain "YYYY-MM-DD" string, like InvoiceRow.invoiceDate. */
  invoiceDate: string | null
  /** Plain "YYYY-MM-DD"; null when the document printed no terms. */
  dueDate: string | null
  totalCents: number
  /** Tax already inside totalCents; 0 when the document prints none. */
  taxCents: number
  /** The printed subtotal before tax and charges; null when unprinted. */
  subtotalCents: number | null
  notes: string
  paymentMethod: InvoicePaymentMethod
  /** See InvoiceRow.currencyCode: document money, never restated. */
  currencyCode: CurrencyCode
  /** "manual" for a hand-entered invoice, "connector" for a service import. */
  source: "manual" | "connector" | null
  fileName: string
  driveWebViewLink: string | null
  /** The Drive file it was read from; null for an upload or a typed-in one. */
  driveFileId: string | null
  /** The slice of that file, when the watcher read it as a bundle and this
   * invoice is one document of it; null for a whole file. */
  driveFilePart: {
    part: number
    pageStart: number | null
    pageEnd: number | null
    region: { x0: number; y0: number; x1: number; y1: number } | null
  } | null
  /** The uploaded file kept on our side, when the invoice came from one; null
   * for a Drive file or a typed-in invoice. */
  documentKey: string | null
  lineCount: number
  matchedLineCount: number
  unresolvedLineCount: number
  createdAt: Date
  lines: InvoiceLineRow[]
}

export type ConnectorProvider = {
  key: string
  displayName: string
  description: string
  icon: string
  capabilities: string[]
  available: boolean
}

export type ConnectorSyncProgress = {
  pagesDone: number
  documentsSeen: number
  documentsImported: number
  documentsSkipped: number
  linesNeedingReview: number
}

export type ConnectorSyncRun = {
  id: string
  providerKey: string
  remoteRunId: string | null
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
  progress: ConnectorSyncProgress
  error: string | null
  queuedAt: string
  startedAt: string | null
  heartbeatAt: string | null
  finishedAt: string | null
}

export type ConnectorConnection = {
  id: string
  providerKey: string
  status:
    "connecting" | "connected" | "needs_reconnect" | "disconnected" | "error"
  lastSyncedAt: string | null
  lastError: string | null
  lastErrorCode: string | null
  latestRun: ConnectorSyncRun | null
}

export type InvoicesOverview = {
  aiUsage: InvoiceAiUsage
  months: Array<{
    month: string
    totals: Array<{ currencyCode: CurrencyCode; totalCents: number }>
  }>
  month: string
  /**
   * Every invoice in the workspace that needs attention, not only this
   * month's: `invoices` is one capped page, this is the whole count.
   */
  needsReviewCount: number
  summary: Array<{
    currencyCode: CurrencyCode
    totalCents: number
    invoiceCount: number
    lineCount: number
    creditCents: number
  }>
  byCategory: Array<{
    categoryId: string | null
    name: string
    currencyCode: CurrencyCode
    totalCents: number
    lineCount: number
  }>
  bySupplier: Array<{
    supplier: string
    supplierName: string
    currencyCode: CurrencyCode
    totalCents: number
    invoiceCount: number
  }>
  /**
   * At most 200 rows: the month, or with `q` the search, or with
   * `tab=attention` the attention list — the last two across every month.
   */
  invoices: InvoiceRow[]
  categories: ExpenseCategoryRow[]
  /** Drive files the poller found that nobody has decided on yet. */
  driveNewCount: number
  /** Drive files the watcher has read that are waiting to be confirmed. */
  driveReadyCount: number
  /** Bring-your-own-key status — extraction runs on the user's Anthropic key. */
  aiKey: AiKeyStatus
  connectors: {
    configured: boolean
    providers: ConnectorProvider[]
    connections: ConnectorConnection[]
  }
}

export type InvoiceAiUsage = {
  usedPages: number
  maxPages: number | null
  /** First day of the next UTC calendar month, as a date-only string. */
  resetsOn: string
  exhausted: boolean
}

/**
 * The product-updates subscription, read from Ghost on every settings render.
 * Ghost is the only record of it, so `enabled` is null when Ghost cannot say
 * and `available` is false when the integration is unconfigured.
 */
export type NewsletterStatus = {
  enabled: boolean | null
  available: boolean
}

/**
 * Whether this workspace has an Anthropic key on file, and the last four
 * characters of it. Safe to render: it never carries the key itself.
 */
export type AiKeyStatus = {
  configured: boolean
  hint: string | null
}

/**
 * The loopback-only read behind `/internal/v1/ai-credential/`: the same status
 * plus the decrypted key.
 *
 * `key` is null in two distinct states, and they are not interchangeable —
 * `configured: false` means no key was ever saved, while `configured: true`
 * with a null `key` means one is stored but could not be decrypted. Only the
 * second is an error worth showing the user.
 */
export type AiCredential = AiKeyStatus & {
  key: string | null
}

/**
 * The Drive folder this workspace imports supplier documents from, and the
 * files it has told Forkluck to stop offering. Ids and names only — Django
 * never holds a document.
 */
export type DriveFolderPayload = {
  folder: { folderId: string; folderName: string } | null
  skipped: Array<{ driveFileId: string; fileName: string; reason: string }>
  watch: DriveWatchSummary | null
}

/**
 * A file in the workspace's Drive registry. `new` is waiting to be read,
 * `ready` has been read unattended and carries a `parts` entry per document
 * found in it,
 * `unsupported` carries the verdict that ruled it out in `reason`, and
 * `imported`, `skipped` and `failed` are decisions a Drive change refreshes
 * the metadata around but never undoes — unless the document itself was
 * edited, which puts a `ready` or `failed` row back to `new`.
 */
export type DriveFileRow = z.infer<typeof driveFileRowSchema>
/** One document the watcher read, stored against a `ready` row; a bundle
 *  leaves several. */
export type DriveFilePart = z.infer<typeof driveFilePartSchema>
export type DriveFileStatus = DriveFileRow["status"]
export type DriveFilesPayload = z.infer<typeof driveFilesPayloadSchema>

/**
 * What the Drive watcher reads: the Changes cursor plus every connected
 * folder. One cursor serves every workspace, because the service account
 * holds one Changes feed over every folder shared with it.
 */
export type DriveWatchPayload = z.infer<typeof driveWatchPayloadSchema>
export type DriveWatchFolder = z.infer<typeof driveWatchFolderSchema>
export type DriveWatchSummary = z.infer<typeof driveWatchSummarySchema>

/** The rows Suppliers → Mapping shows: what a supplier's code or description
 *  buys, and the keys the merchant told Forkluck to stop asking about. */
export type SupplierItemMappingRow = z.infer<typeof supplierItemRowSchema>
export type SupplierItemIgnoreRow = z.infer<typeof supplierItemIgnoreRowSchema>

export type EmployeeHourlyRateRow = {
  id: string
  hourlyRateCents: number
  effectiveFrom: string
}

export type EmployeeRow = {
  id: string
  name: string
  normalizedName: string
  isActive: boolean
  /** Their hours still report; only their money stops counting. */
  excludedFromCost: boolean
  currentHourlyRateCents: number | null
  currentRateEffectiveFrom: string | null
  shiftCount: number
  /** Clocked time. What the break rule took off is reported beside it. */
  totalSeconds: number
  unpaidBreakSeconds: number
  laborCostCents: number
  /** The employer burden on that wage — derived from the workspace rate. */
  payrollTaxCents: number
  uncostedCount: number
  firstShiftAt: Date | null
  lastShiftAt: Date | null
  rateHistory: EmployeeHourlyRateRow[]
}

export type LaborImportRow = {
  id: string
  fileName: string
  source: string
  timezone: string
  periodStart: string | null
  periodEnd: string | null
  totalRows: number
  importedCount: number
  createdEmployeeCount: number
  duplicateCount: number
  skippedCount: number
  excludedCount: number
  totalSeconds: number
  totalLaborCostCents: number
  uncostedCount: number
  createdAt: Date
  undoneAt: Date | null
  canUndo: boolean
}

export type TimeEntryRow = {
  id: string
  employeeId: string
  employeeName: string
  clockIn: Date
  clockOut: Date
  paidSeconds: number
  /** Deducted by the workspace's auto-deduct rule; zero when it is off. */
  unpaidBreakSeconds: number
  /** What the timesheet itself reported. Recorded, never deducted. */
  breakSeconds: number
  timeAdjustmentSeconds: number
  earningsAdjustmentCents: number
  hourlyRateCents: number | null
  laborCostCents: number | null
  comment: string
  importId: string
  importTimezone: string
}

export type LaborOverview = {
  period: {
    start: string | null
    end: string | null
    comparisonStart: string | null
    comparisonEnd: string | null
    comparison: NetSalesTrend["comparison"]
    timezone: string
    availableDates: string[]
  }
  summary: {
    employeeCount: number
    totalSeconds: number
    unpaidBreakSeconds: number
    totalLaborCostCents: number
    payrollTaxCents: number
    uncostedSeconds: number
    uncostedCount: number
  }
  comparisonSummary: LaborOverview["summary"]
  /** The rules behind the numbers above, so the screen can name them. */
  policy: {
    payrollTaxPercent: number
    unpaidBreakMinutes: number
    unpaidBreakPerHours: number
  }
  overtime: {
    weeklyThresholdMinutes: number
    byEmployee: Record<
      string,
      Array<{ weekStart: string; totalSeconds: number }>
    >
  }
  employees: EmployeeRow[]
  imports: LaborImportRow[]
}

export type LaborEmployeeDetail = {
  period: {
    start: string
    end: string
    timezone: string
  }
  employee: EmployeeRow
  shifts: TimeEntryRow[]
  pagination: {
    page: number
    limit: number
    pages: number
    total: number
  }
}

export type SalesIdentityKind = "item" | "modifier"

export type SalesProductVariantRow = z.infer<typeof salesProductVariantSchema>

/** Counts every mapping change returns so the UI can explain what moved. */
export type SalesInterpretationReceipt = {
  parentLinesAttached: number
  parentLinesDetached: number
  modifierOccurrencesAttached: number
  modifierOccurrencesDetached: number
  linesReinterpreted: number
  conflicts: Array<{
    matchKey: string
    reason: string
    productId: string | null
  }>
}

export type PosConnectionRow = z.infer<typeof posConnectionSchema>

export type PosSyncReceipt = z.infer<typeof posSyncReceiptSchema> & {
  provider: "square" | "shopify"
  batchId: string | null
  /** Every stored line — tracked, pending, and ignored alike. */
  imported: number
  /** Existing immutable provider records replaced with corrected facts. */
  updated: number
  deduplicated: number
  trackedLines: number
  pendingLines: number
  ignoredLines: number
  pendingIdentities: number
  ignoredIdentities: number
  /** Malformed/unsupported records only — never merely unmapped ones. */
  skippedMalformed: number
  modifierOccurrences: number
  modifierOccurrencesAttached: number
  modifierOccurrencesPending: number
  pendingModifierIdentities: number
  skippedModifiersMalformed: number
  /** Always 0 — kept so older receipts keep parsing. */
  skippedUnmatched: number
  /** Always 0 — kept so older receipts keep parsing. */
  skippedIgnored: number
  warnings: number
  partial: boolean
  /** Provider pages read in this pass — the unit the time budget spends. */
  pagesProcessed: number
  /** Provider lines read before dedupe; `imported` is the stored subset. */
  linesFetched: number
  /** Pending lines that gained a catalog category name after the pass. */
  categoriesBackfilled: number
  periodStart: string | null
  periodEnd: string | null
}

export type PosSyncRun = z.infer<typeof posSyncRunSchema>

export type SalesProductRow = z.infer<typeof salesProductSchema>

export type DailySalesRow = z.infer<typeof dailySalesSchema>

export type PeriodProductSalesRow = z.infer<typeof periodProductSalesSchema>

export type ProductComponent = z.infer<typeof productComponentSchema>

export type ProductDetail = z.infer<typeof productDetailSchema>

/** One reason a physical value could not be resolved. */
export type ExpansionIssue = z.infer<typeof expansionIssueSchema>

export type ProductDetailSales = z.infer<typeof productDetailSalesSchema>

export type MenuForecast = z.infer<typeof menuForecastPayloadSchema>

export type MenuForecastPlan = MenuForecast["basis"]["plan"]

export type SalesImportRow = z.infer<typeof salesImportSchema>

export type NetSalesTrend = z.infer<typeof netSalesTrendSchema>

export type SalesOverview = z.infer<typeof salesOverviewSchema>

/** One financial line behind an external identity, for the detail dialog. */
export type SalesIdentityLine = {
  id: string
  soldAt: Date
  /** The IANA zone the sale was recorded in; format times with it. */
  timezone: string
  externalOrderId: string
  externalVariantTitle: string
  quantity: number
  grossCents: number
  discountCents: number
  netSalesCents: number
  refundCents: number
  currencyCode: string
  location: string
  employeeName: string
  orderSource: string
}

export type SalesReviewItem = {
  channel: "square" | "shopify"
  providerAccountId: string
  matchKey: string
  externalObjectId: string
  productExternalObjectId: string
  sku: string
  itemName: string
  externalVariantTitle: string
  lineCount: number
  quantity: number
  /** POS order sources, biggest earner first: "Invoices", "Point of Sale". */
  orderSources: string[]
  netSalesCents: number
  /**
   * The currency this identity's sales were recorded in — POS document money,
   * so it may differ from the workspace code and must be used to format it.
   * "" for a catalog-only row, which has no sales.
   */
  currencyCode: string
  /** True when imported sales contain modifier choices beneath this item. */
  hasModifiers: boolean
  /** POS catalog category name; "" when the provider gave none. */
  category: string
  lastSoldAt: Date | null
  suggestedProductId: string | null
  suggestedProductName: string | null
  suggestionReason: "sku" | "name" | "canonical" | null
}

/**
 * One channel+category bucket rolled up over *every* pending group, not just
 * the rows the payload carries — the ignore-by-category sweep covers all of it.
 */
export type SalesReviewCategory = {
  channel: "square" | "shopify"
  providerAccountId: string
  /** "" is the uncategorized bucket, and is a legal value to ignore. */
  category: string
  keyCount: number
  /** Pending rows sourced only from a connected provider catalog. */
  catalogOnlyKeyCount: number
  lineCount: number
  netSalesCents: number
}

export type SalesModifierReviewItem = {
  channel: "square" | "shopify"
  providerAccountId: string
  matchKey: string
  name: string
  sku: string
  externalObjectId: string
  parentItemName: string
  /** "Sampler > Chocolate Cookie" — the row's context in one string. */
  contextLabel: string
  usageCount: number
  quantity: number
  /** ISO timestamp; not revived to a Date by the backend client. */
  lastSeenAt: string | null
}

type SalesIgnoredIdentityBase = {
  id: string
  channel: "square" | "shopify"
  providerAccountId: string
  matchKey: string
  sku: string
  externalName: string
  externalVariantTitle: string
  /** Stored sales remain attached to an ignored identity for later mapping. */
  lineCount: number
  quantity: number
  netSalesCents: number
  /** Document money's own currency; "" when this identity never sold. */
  currencyCode: string
  /** Revived to a Date by the backend client's key allowlist. */
  lastSoldAt: Date | null
  /** A rule owns its rows; only the rule can release them. */
  source: "manual" | "rule"
  ruleId: string | null
}

export type SalesIgnoredItem = SalesIgnoredIdentityBase & {
  identityKind: "item"
}

export type SalesIgnoredModifier = SalesIgnoredIdentityBase & {
  identityKind: "modifier"
}

export type SalesIgnoredIdentity = SalesIgnoredItem | SalesIgnoredModifier

export type SalesModifierCatalogOption = {
  id: string
  externalObjectId: string
  name: string
  ordinal: number
  priceCents: number | null
  currencyCode: string
  variantId: string | null
  productId: string | null
  productName: string | null
  quantityMultiplier: number
}

export type SalesModifierCatalogRecord = SalesModifierReviewItem & {
  variantId: string | null
  productId: string | null
  productName: string | null
  quantityMultiplier: number
}

export type SalesModifierCatalogList = {
  id: string
  channel: "square" | "shopify"
  providerAccountId: string
  externalObjectId: string
  name: string
  modifierType: string
  selectionType: string
  allowQuantities: boolean
  minSelected: number
  maxSelected: number
  mappedCount: number
  options: SalesModifierCatalogOption[]
  /** Sales identities represented by this list, including retired Square ids. */
  records: SalesModifierCatalogRecord[]
}

/**
 * Opt-in blocks of the menu overview. `items` is the product list without
 * sales numbers; `stats` implies `items` and fills in per-product sales.
 * Unrequested blocks come back empty but present.
 */
export type MenuOverviewSection =
  "modifiers" | "review" | "ignored" | "items" | "recipes" | "stats" | "rules"

export const SALES_RULE_FIELDS = ["sku", "title", "variant"] as const
export const SALES_RULE_OPERATORS = ["is", "starts_with", "contains"] as const

export type SalesIgnoreRuleCondition = {
  field: (typeof SALES_RULE_FIELDS)[number]
  operator: (typeof SALES_RULE_OPERATORS)[number]
  value: string
}

export type SalesIgnoreRuleRow = {
  id: string
  /** `null` covers every channel. */
  channel: "square" | "shopify" | null
  enabled: boolean
  /** ANDed: every condition must hold for an identity to be covered. */
  conditions: SalesIgnoreRuleCondition[]
  /** What this rule holds *now* — overlap is settled by first claim. */
  ignoredCount: number
  createdAt: Date
  updatedAt: Date
}

export type SalesIgnoreRuleMatch = {
  channel: "square" | "shopify"
  providerAccountId: string
  matchKey: string
  sku: string
  itemName: string
  externalVariantTitle: string
  /** `tracked` is what the rule will leave alone; `ignored` is already gone. */
  status: "pending" | "ignored" | "tracked"
}

export type MenuOverview = {
  items: SalesProductRow[]
  recipes: Array<{ id: string; publicId: string; title: string }>
  rules: SalesIgnoreRuleRow[]
  modifierCatalog: {
    squareConnected: boolean
    squareNeedsReconnect: boolean
    squareSyncedAt: string | null
    /** Last sales sync. Later than `squareSyncedAt` means lists are behind. */
    squareSalesSyncedAt: string | null
    lists: SalesModifierCatalogList[]
    /** Records whose list cannot be inferred safely. */
    unassignedRecords: SalesModifierCatalogRecord[]
  }
  review: {
    /** Capped per category; `reviewCount` is the true pending total. */
    items: SalesReviewItem[]
    reviewCount: number
    /** Matching identities before the 200-row display cap. */
    reviewMatchCount: number
    /** Rolled up over every pending group — never capped. */
    categories: SalesReviewCategory[]
    /** Capped at 200 rows; `modifierReviewCount` is the true total. */
    modifiers: SalesModifierReviewItem[]
    modifierReviewCount: number
    /** Each list is capped at 500 rows; its matching count is the true total. */
    ignoredItems: SalesIgnoredItem[]
    ignoredModifiers: SalesIgnoredModifier[]
    ignoredItemCount: number
    ignoredModifierCount: number
    ignoredCount: number
  }
}

export type PricingEntries = z.infer<typeof pricingEntriesPayloadSchema>

export type RecipeSummary = z.infer<typeof recipeSummarySchema>
export type RecipeDetail = z.infer<typeof recipeDetailSchema>
export type GuestRecipe = z.infer<typeof guestRecipePayloadSchema>["item"]
export type GuestBook = z.infer<typeof guestBookPayloadSchema>["item"]
export type RecipeNutrition = z.infer<typeof recipeNutritionSchema>
export type AllergenHints = z.infer<typeof allergenHintsSchema>
export type RecipeNutritionLine = z.infer<typeof recipeNutritionLineSchema>
export type RecipeCostDiff = z.infer<typeof recipeCostDiffPayloadSchema>["item"]
export type RecipeCostDiffLine = RecipeCostDiff["lines"][number]
export type Nutrients = z.infer<typeof nutrientsSchema>
export type NutritionReadinessFormat = "us" | "eu"

export type RecipeExternalRef = {
  id: string
  system: ExternalRefSystem
  refKind: ExternalRefKind
  externalId: string
}

export type RecipeRow = RecipeDetail

export type BenchcostTimingRow = {
  id: string
  stepId: string
  seconds: number
  yieldCount: number
  createdAt: Date
}

export type BenchcostStepWithTimings = {
  id: string
  recipeId: string
  name: string
  kind: "active" | "passive"
  covers: number
  position: number
  timings: BenchcostTimingRow[]
}

export type BenchcostRecipeWithData = {
  id: string
  userId: string
  recipeId: string | null
  name: string
  ingredientCostCents: number
  packagingCostCents: number
  batchYield: number
  sellableYield: number | null
  position: number
  createdAt: Date
  updatedAt: Date
  steps: BenchcostStepWithTimings[]
}

export type InvoiceLineOption = {
  id: string
  supplier: string
  description: string
  sku: string
  packSize: string
  /** How many packs the line bought — `lineAmountCents` covers all of them. */
  quantity: number | null
  unitPriceCents: number | null
  lineAmountCents: number
  currencyCode: string
  invoiceDate: string | null
  linkedIngredients: Array<{ name: string; publicId: string }>
}

export type MenuRow = {
  id: string
  publicId: string
  name: string
  periodStart: string | null
  periodEnd: string | null
  itemCount: number
  updatedAt: Date
}

export type MenusPayload = {
  menus: MenuRow[]
  hasAnyMenu: boolean
}

export type MenuItemOriginal = {
  sellPriceCents: number
  qtySold: number
  foodCostCents: number | null
}

/** One worksheet row: a link to a recipe or a product, never a composition.
 * Name, category and food cost are the link's, read live. */
export type MenuItemRow = {
  id: string
  name: string
  position: number
  sellPriceCents: number
  qtySold: number
  recipeId: string | null
  recipePublicId: string | null
  recipeName: string | null
  productId: string | null
  productPublicId: string | null
  productName: string | null
  /** The link's category; null on a row that has no link. */
  category: string | null
  /** Null when the source cannot be costed, or the row has no link. */
  foodCostCents: number | null
  sourceSellPriceCents: number | null
  /** The product's units sold over the menu's period; null for recipe rows. */
  sourceQtySold: number | null
  original: MenuItemOriginal
}

export type MenuRecipeOption = {
  id: string
  publicId: string
  title: string
  kind: string
  category: string | null
  menuPriceCents: number | null
  ingredientCents: number | null
  suffix: string
}

export type MenuIngredientOption = {
  id: string
  name: string
  purchaseUnit: string | null
  /** Whether the ingredient is packaging or another non-food supply. */
  nonEdible: boolean
}

export type MenuProductOption = {
  id: string
  publicId: string
  name: string
  /** This product's direct product members, so a picker can refuse a cycle
   * before the server has to. */
  componentProductIds: string[]
}

export type MenuSources = {
  recipes: MenuRecipeOption[]
  ingredients: MenuIngredientOption[]
  products: MenuProductOption[]
  currencyCode: string
}

export type MenuDetail = {
  menu: {
    id: string
    publicId: string
    /** The optimistic-concurrency counter a save sends back as its expectation. */
    editVersion: number
    name: string
    periodStart: string | null
    periodEnd: string | null
    createdAt: Date
    updatedAt: Date
  }
  items: MenuItemRow[]
  recipes: MenuRecipeOption[]
  ingredients: MenuIngredientOption[]
  products: MenuProductOption[]
  currencyCode: string
}

export type ActivityResourceType =
  | "recipe"
  | "ingredient"
  | "menu"
  | "invoice"
  | "category"
  | "import"
  | "settings"
  | "connection"
  | "workspace"

export type ActivityEventKind =
  | "added"
  | "edited"
  | "deleted"
  | "archived"
  | "restored"
  | "imported"
  | "connected"
  | "disconnected"

/** One line of the workspace history. `context` carries whatever the writer
 *  attached, `publicId` among it for the resources that have a page. */
export type ActivityEvent = {
  id: string
  actorName: string
  resourceType: ActivityResourceType
  resourceId: string | null
  event: ActivityEventKind
  name: string
  context: Record<string, unknown>
  createdAt: Date
}

export type ActivityPayload = {
  items: ActivityEvent[]
  /** Cursor for the next, older page, or null at the end of history. */
  nextBefore: string | null
}
