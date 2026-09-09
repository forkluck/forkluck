import { cache } from "react"

import type {
  ActivityEventKind,
  ActivityPayload,
  ActivityResourceType,
  AiCredential,
  ConnectorSyncRun,
  DashboardOverview,
  DriveFilesPayload,
  DriveFileStatus,
  DriveFolderPayload,
  DriveWatchPayload,
  IngredientImportRow,
  InvoiceLineOption,
  InvoicesOverview,
  LaborOverview,
  LaborEmployeeDetail,
  MenuDetail,
  MenuOverview,
  MenuOverviewSection,
  MenuSources,
  MenusPayload,
  NewsletterStatus,
  PosConnectionRow,
  PosSyncRun,
  ProductDetail,
  MenuForecast,
  MenuForecastPlan,
  RecipeCostDiff,
  SalesIdentityLine,
  PricingEntries,
  PrimoConversation,
  PrimoConversationList,
  NetSalesTrend,
  SalesImportRow,
  SalesOverview,
  SalesProductRow,
} from "@/lib/backend/types"
import {
  BackendRequestError,
  BackendUnauthorizedError,
  djangoGet,
  djangoGetParsed,
  djangoSystemAction,
  djangoSystemGet,
} from "@/lib/backend/client"
import {
  activityPayloadSchema,
  authMethodsSchema,
  connectorSyncRunPayloadSchema,
  connectorSyncRunsPayloadSchema,
  driveFilesPayloadSchema,
  driveFolderPayloadSchema,
  driveWatchPayloadSchema,
  ingredientPayloadSchema,
  ingredientCategoriesPayloadSchema,
  productCategoriesPayloadSchema,
  ingredientTagsPayloadSchema,
  ingredientsPayloadSchema,
  invoiceDetailPayloadSchema,
  invoiceSuppliersPayloadSchema,
  kitchenMembersPayloadSchema,
  supplierItemIgnoresPayloadSchema,
  supplierItemsPayloadSchema,
  menuItemsPayloadSchema,
  menuProductRowsPayloadSchema,
  guestBookPayloadSchema,
  guestRecipePayloadSchema,
  pricingEntriesPayloadSchema,
  primoConversationListSchema,
  primoConversationSchema,
  posConnectionsPayloadSchema,
  posSyncRunPayloadSchema,
  posSyncRunsPayloadSchema,
  productDetailPayloadSchema,
  menuForecastPayloadSchema,
  recipeCostDiffPayloadSchema,
  recipeNutritionPayloadSchema,
  recipeCategoriesPayloadSchema,
  recipePayloadSchema,
  recipesPayloadSchema,
  salesOverviewSchema,
  searchIndexPayloadSchema,
  newsletterStatusSchema,
  sessionPayloadSchema,
  type SessionPayload,
  type RecipeFacets,
} from "@/lib/backend/schemas"
import {
  browsePath,
  type BrowseQuery,
  type BrowseResult,
} from "@/lib/backend/pagination"
import type {
  IngredientBrowseKind,
  IngredientBrowseStatus,
  IngredientRow,
  IngredientSummary,
} from "@/lib/backend/types"
import type { DuplicateSuggestion } from "@/lib/ingredient-insights"
import type { InvoiceLineStatus } from "@/lib/invoice-import"
import type { CurrencyCode } from "@/lib/business-settings"
import type { RecipeHealth } from "@/lib/recipe/health"
import {
  resolveFoodCostTarget,
  resolvePayrollTaxPercent,
  resolveProductMatching,
  resolveTimezone,
  resolveOvertimeWeeklyMinutes,
  resolveUnpaidBreakMinutes,
  resolveUnpaidBreakPerHours,
  type BusinessSettings,
} from "@/lib/business-settings"

export async function getAuthMethods() {
  return djangoGetParsed("/internal/v1/auth-methods/", authMethodsSchema)
}

/**
 * The signed-in session, or null when the backend rejects the cookie.
 *
 * `lib/auth-session.ts` wraps this in React `cache()` and owns the redirect;
 * the route and its schema stay here so the seam holds the whole contract.
 */
export async function getSessionPayload(): Promise<SessionPayload | null> {
  try {
    return await djangoGetParsed("/internal/v1/session/", sessionPayloadSchema)
  } catch (error) {
    if (error instanceof BackendUnauthorizedError) return null
    throw error
  }
}

/** The signed-in user's product-updates subscription, as Ghost holds it. */
export async function getNewsletterStatus(): Promise<NewsletterStatus> {
  return djangoGetParsed("/internal/v1/newsletter/", newsletterStatusSchema)
}

/**
 * The user's own Anthropic key, for the invoice extraction fallback.
 *
 * Loopback-only: the key never reaches the browser, so no caller outside the
 * Next server should ever see this payload.
 */
export async function getAiCredential(): Promise<AiCredential> {
  return djangoGet<AiCredential>("/internal/v1/ai-credential/")
}

/** The connected Drive folder, the files this workspace skips, and the poller. */
export async function getDriveFolder(): Promise<DriveFolderPayload> {
  return djangoGetParsed("/internal/v1/drive-folder/", driveFolderPayloadSchema)
}

/** One status of the Drive registry, newest change first. */
export async function getDriveFiles(
  status: DriveFileStatus,
  limit?: number
): Promise<DriveFilesPayload> {
  const suffix = limit === undefined ? "" : `&limit=${limit}`
  return djangoGetParsed(
    `/internal/v1/drive-files/?status=${status}${suffix}`,
    driveFilesPayloadSchema
  )
}

/**
 * What the Drive watcher polls with: the shared Changes cursor and every
 * connected folder. A system read — it runs on a timer with no session, so it
 * cannot go through `djangoGetParsed`, which forwards the request's cookie.
 */
export async function getDriveWatch(): Promise<DriveWatchPayload> {
  const payload = await djangoSystemGet<DriveWatchPayload>(
    "/internal/v1/system/drive-watch/"
  )
  if (process.env.NODE_ENV !== "production")
    driveWatchPayloadSchema.parse(payload)
  return payload
}

/**
 * The watcher's two writes. They are not actions — no session, no slug — so
 * they live here with the read they belong to rather than behind
 * `djangoAction`, and the route stays inside the seam.
 */
export function saveDriveWatch(state: {
  pageToken: string
  polledAt: string
  lastError: string
}): Promise<{ ok: true }> {
  return djangoSystemAction<{ ok: true }>(
    "/internal/v1/system/drive-watch/save/",
    state
  )
}

/** One workspace's slice of a poll: at most 500 files, `markRegistered` when
 * they are a full listing of its folder rather than a page of changes. */
export function registerDriveFiles(body: {
  userId: string
  files: unknown[]
  markRegistered: boolean
}): Promise<{ registered: number; removed: number; newCount: number }> {
  return djangoSystemAction("/internal/v1/system/drive-files/", body)
}

/**
 * The reader's half of the registry: what one workspace still owes a read
 * (`new`), what it has read (`ready`) and what it failed on, oldest first so a
 * backlog is worked through in the order the receipts arrived. A system read —
 * the watcher has no session to scope it with, so the workspace is named.
 */
export async function getDriveFilesForWorkspace(
  userId: string,
  status: "new" | "ready" | "failed",
  limit?: number
): Promise<DriveFilesPayload> {
  const suffix = limit === undefined ? "" : `&limit=${limit}`
  const payload = await djangoSystemGet<DriveFilesPayload>(
    `/internal/v1/system/drive-files/?userId=${encodeURIComponent(userId)}` +
      `&status=${status}${suffix}`
  )
  if (process.env.NODE_ENV !== "production")
    driveFilesPayloadSchema.parse(payload)
  return payload
}

/**
 * The attended path's probe, run for the watcher. Same body and same payload
 * as the `invoice-line-status` action, plus the workspace currency: an
 * unattended read has no session to look one up with, and a document that
 * printed its own currency is normalized against it.
 */
export function probeInvoiceLinesForWorkspace(
  userId: string,
  body: Record<string, unknown>
): Promise<InvoiceLineStatus & { currencyCode: CurrencyCode }> {
  return djangoSystemAction("/internal/v1/system/invoice-line-status/", {
    userId,
    ...body,
  })
}

export function updateInvoiceAiUsageForWorkspace<T>(
  userId: string,
  body: Record<string, unknown>
): Promise<T> {
  return djangoSystemAction("/internal/v1/system/invoice-ai-usage/", {
    ...body,
    userId,
  })
}

/** Store what the watcher read and put the file up for review — one entry per
 *  document found in the file, so a bundle arrives as the receipts it holds.
 *  The row must still be waiting to be read, so a late reader never overwrites
 *  an import or a skip. */
export function saveDriveExtraction(body: {
  userId: string
  driveFileId: string
  parts: Array<{
    /** 0-based, in the order the documents appear in the file. */
    part: number
    document: Record<string, unknown>
    /** A page range of the file, a region of the prepared photo, or neither
     *  when the whole file is the document. */
    pageStart?: number | null
    pageEnd?: number | null
    region?: { x0: number; y0: number; x1: number; y1: number } | null
    /** What read this part: the parts of one file need not agree. */
    model: string
    escalated: boolean
  }>
}): Promise<{ ok: true; readyCount: number }> {
  return djangoSystemAction("/internal/v1/system/drive-extractions/", body)
}

/** The other outcome: the read produced no invoice. `retry-drive-file` puts
 *  the row back in line. */
export function failDriveExtraction(body: {
  userId: string
  driveFileId: string
  reason: string
}): Promise<{ ok: true }> {
  return djangoSystemAction(
    "/internal/v1/system/drive-extractions/failed/",
    body
  )
}

/** `status` is absent for the active pantry, "archived", or "all"; `kind` is
 * absent for food, "supply" for packaging, or "all"; `category` is a
 * tenant-owned category id. */
export async function browseIngredients(
  query: BrowseQuery & {
    status?: IngredientBrowseStatus
    kind?: IngredientBrowseKind
    category?: string
  } = {}
): Promise<BrowseResult<IngredientSummary> & { hasAnyIngredient: boolean }> {
  const { status, kind, category, ...browse } = query
  return djangoGetParsed(
    browsePath("/internal/v1/ingredients/", {
      ...browse,
      filters: { ...browse.filters, status, kind, category },
    }),
    ingredientsPayloadSchema
  )
}

export const getIngredient = cache(
  async (ingredientRef: string): Promise<IngredientRow | null> => {
    const result = await djangoGetParsed(
      `/internal/v1/ingredients/${encodeURIComponent(ingredientRef)}/`,
      ingredientPayloadSchema
    )
    return result.item
  }
)

/** Everything the recipe editor prices with, in one unpaginated read. */
export async function getPricingEntries(): Promise<PricingEntries> {
  return djangoGetParsed(
    "/internal/v1/pricing-entries/",
    pricingEntriesPayloadSchema
  )
}

export async function getIngredientImports() {
  const result = await djangoGet<{ items: IngredientImportRow[] }>(
    "/internal/v1/ingredient-imports/"
  )
  return result.items
}

export async function getIngredientOptions() {
  const result = await djangoGet<{
    items: Array<{ id: string; name: string; nonEdible: boolean }>
  }>("/internal/v1/ingredient-options/")
  return result.items
}

/** The workspace's own payment methods; the four built-ins are constants. */
export async function getPaymentMethods() {
  const result = await djangoGet<{
    items: Array<{ id: string; name: string }>
  }>("/internal/v1/payment-methods/")
  return result.items
}

export async function getIngredientCategories() {
  const result = await djangoGetParsed(
    "/internal/v1/ingredient-categories/",
    ingredientCategoriesPayloadSchema
  )
  return result.items
}

export async function getProductCategories() {
  const result = await djangoGetParsed(
    "/internal/v1/product-categories/",
    productCategoriesPayloadSchema
  )
  return result.items.map((item) => item.label)
}

export async function getRecipeCategories() {
  const result = await djangoGetParsed(
    "/internal/v1/recipe-categories/",
    recipeCategoriesPayloadSchema
  )
  return result.items
}

export async function getIngredientTags() {
  const result = await djangoGetParsed(
    "/internal/v1/ingredient-tags/",
    ingredientTagsPayloadSchema
  )
  return result.items
}

export async function getIngredientDuplicates() {
  const result = await djangoGet<{ items: DuplicateSuggestion[] }>(
    "/internal/v1/ingredient-duplicates/"
  )
  return result.items
}

export async function getLaborOverview(
  startDate?: string,
  endDate?: string,
  comparison: NetSalesTrend["comparison"] = "fifty_two_weeks_prior"
): Promise<LaborOverview> {
  const params = new URLSearchParams()
  if (startDate) params.set("start", startDate)
  if (endDate && endDate !== startDate) params.set("end", endDate)
  // Send the selected comparison verbatim: the labor endpoint defaults an
  // absent value to `fifty_two_weeks_prior`, so omitting `prior_day` would
  // silently swap the labor baseline out from under the sales window and the
  // metric labels, which carry the same mode.
  params.set("comparison", comparison)
  const suffix = params.size ? `?${params}` : ""
  return djangoGet<LaborOverview>(`/internal/v1/labor-overview/${suffix}`)
}

export async function getLaborEmployeeDetail(
  employeeId: string,
  page = 1,
  startDate?: string,
  endDate?: string
) {
  const params = new URLSearchParams()
  if (page > 1) params.set("page", String(page))
  if (startDate) params.set("start", startDate)
  if (endDate && endDate !== startDate) params.set("end", endDate)
  const suffix = params.size ? `?${params}` : ""
  const result = await djangoGet<{ item: LaborEmployeeDetail | null }>(
    `/internal/v1/labor-employees/${encodeURIComponent(employeeId)}/${suffix}`
  )
  return result.item
}

export async function getSalesOverview(
  trendStartDate?: string,
  trendEndDate?: string,
  trendComparison: NetSalesTrend["comparison"] = "prior_day",
  timeZone?: string
): Promise<SalesOverview> {
  const params = new URLSearchParams()
  if (trendStartDate) params.set("start", trendStartDate)
  if (trendEndDate && trendEndDate !== trendStartDate) {
    params.set("end", trendEndDate)
  }
  if (trendComparison !== "prior_day") {
    params.set("comparison", trendComparison)
  }
  if (timeZone) params.set("timezone", timeZone)
  const suffix = params.size ? `?${params}` : ""
  return djangoGetParsed(
    `/internal/v1/sales-overview/${suffix}`,
    salesOverviewSchema
  )
}

export async function getSalesImports(): Promise<SalesImportRow[]> {
  const result = await djangoGet<{ items: SalesImportRow[] }>(
    "/internal/v1/sales-imports/"
  )
  return result.items
}

export const getPosConnections = cache(
  async (): Promise<PosConnectionRow[]> => {
    const result = await djangoGetParsed(
      "/internal/v1/pos-connections/",
      posConnectionsPayloadSchema
    )
    return result.items
  }
)

export async function getPosSyncRuns(): Promise<PosSyncRun[]> {
  const result = await djangoGetParsed(
    "/internal/v1/pos-sync-runs/",
    posSyncRunsPayloadSchema
  )
  return result.items
}

export async function getPosSyncRun(id: string): Promise<PosSyncRun | null> {
  try {
    const result = await djangoGetParsed(
      `/internal/v1/pos-sync-runs/${encodeURIComponent(id)}/`,
      posSyncRunPayloadSchema
    )
    return result.syncRun
  } catch (cause) {
    if (cause instanceof BackendRequestError && cause.status === 404)
      return null
    throw cause
  }
}

export async function getConnectorSyncRuns(): Promise<ConnectorSyncRun[]> {
  const result = await djangoGetParsed(
    "/internal/v1/connector-sync-runs/",
    connectorSyncRunsPayloadSchema
  )
  return result.items
}

export async function getConnectorSyncRun(
  id: string
): Promise<ConnectorSyncRun> {
  const result = await djangoGetParsed(
    `/internal/v1/connector-sync-runs/${encodeURIComponent(id)}/`,
    connectorSyncRunPayloadSchema
  )
  return result.run
}

/**
 * The invoices page in one read. `month` scopes the totals and the default
 * row list; `q` searches every month, and `tab: "attention"` lists every
 * month's unfinished invoices. The totals stay on the month either way.
 */
export async function getInvoicesOverview(
  params: { month?: string; q?: string; tab?: "attention" } = {}
): Promise<InvoicesOverview> {
  const search = new URLSearchParams()
  if (params.month) search.set("month", params.month)
  if (params.q?.trim()) search.set("q", params.q.trim())
  if (params.tab === "attention") search.set("tab", "attention")
  const suffix = search.size ? `?${search}` : ""
  return djangoGet<InvoicesOverview>(`/internal/v1/invoices-overview/${suffix}`)
}

/**
 * Every supplier the workspace buys from, with its contact details and what
 * still points at it. The counts are aggregated in Django; this used to count
 * in Next by downloading every ingredient, each with its full price history
 * and supplier items, purely to total them by supplier.
 */
export async function getInvoiceSuppliers() {
  const result = await djangoGetParsed(
    "/internal/v1/invoice-suppliers/",
    invoiceSuppliersPayloadSchema
  )
  return result.items
}

/**
 * One page of the supplier memory Suppliers → Mapping edits: the remembered
 * packs, or with `tab: "ignored"` the keys that are skipped.
 */
export async function getSupplierItems(params: {
  supplier?: string
  q?: string
  tab?: "items" | "ignored"
  limit?: number
  offset?: number
}) {
  const search = new URLSearchParams()
  if (params.supplier) search.set("supplier", params.supplier)
  if (params.q?.trim()) search.set("q", params.q.trim())
  if (params.tab === "ignored") search.set("tab", "ignored")
  if (params.limit) search.set("limit", String(params.limit))
  if (params.offset) search.set("offset", String(params.offset))
  const suffix = search.size ? `?${search}` : ""
  const url = `/internal/v1/supplier-items/${suffix}`
  return params.tab === "ignored"
    ? djangoGetParsed(url, supplierItemIgnoresPayloadSchema)
    : djangoGetParsed(url, supplierItemsPayloadSchema)
}

export async function searchInvoiceLineOptions(query: string) {
  const suffix = query ? `?q=${encodeURIComponent(query)}` : ""
  const result = await djangoGet<{ items: InvoiceLineOption[] }>(
    `/internal/v1/invoice-line-options/${suffix}`
  )
  return result.items
}

/** One invoice with its lines, keyed by the public id in the URL. */
export async function getInvoice(publicId: string) {
  try {
    const result = await djangoGetParsed(
      `/internal/v1/invoices/${encodeURIComponent(publicId)}/`,
      invoiceDetailPayloadSchema
    )
    return result.item
  } catch (cause) {
    if (cause instanceof BackendRequestError && cause.status === 404)
      return null
    throw cause
  }
}

export async function getMenuOverview(
  sections?: readonly MenuOverviewSection[],
  reviewQuery?: string
): Promise<MenuOverview> {
  const params = new URLSearchParams()
  if (sections) params.set("sections", sections.join(","))
  if (reviewQuery?.trim()) params.set("q", reviewQuery.trim())
  const query = params.size ? `?${params}` : ""
  return djangoGet<MenuOverview>(`/internal/v1/menu-overview/${query}`)
}

/** The most recent financial lines behind one Catalog identity. */
export async function getSalesIdentityLines(input: {
  channel: "square" | "shopify"
  providerAccountId: string
  matchKey: string
}): Promise<{ items: SalesIdentityLine[]; lineCount: number }> {
  const params = new URLSearchParams({
    channel: input.channel,
    account: input.providerAccountId,
    key: input.matchKey,
  })
  return djangoGet(`/internal/v1/sales-identity-lines/?${params}`)
}

export async function browseMenuItems(
  query: BrowseQuery = {}
): Promise<BrowseResult<SalesProductRow> & { hasAnyProduct: boolean }> {
  return djangoGetParsed(
    browsePath("/internal/v1/menu-items/", query),
    menuItemsPayloadSchema
  )
}

/**
 * The products a menu worksheet picks from, over the menu's own period.
 *
 * Products is a catalog and reports no sales; the import and connect dialogs
 * need units and attributed money for the days the menu ran, busiest first,
 * so they read this instead of the browse endpoint.
 */
export async function getMenuProductRows(input: {
  q?: string
  start?: string | null
  end?: string | null
}): Promise<{ items: SalesProductRow[] }> {
  const params = new URLSearchParams()
  if (input.q) params.set("q", input.q)
  if (input.start) params.set("start", input.start)
  if (input.end && input.end !== input.start) params.set("end", input.end)
  const suffix = params.size ? `?${params}` : ""
  return djangoGetParsed(
    `/internal/v1/menu-product-rows/${suffix}`,
    menuProductRowsPayloadSchema
  )
}

/** One tenant-scoped Products Hub product, with an optional sales window. */
export async function getProductDetail(
  productRef: string,
  startDate?: string,
  endDate?: string
): Promise<ProductDetail | null> {
  const params = new URLSearchParams()
  if (startDate) params.set("start", startDate)
  if (endDate && endDate !== startDate) params.set("end", endDate)
  const suffix = params.size ? `?${params}` : ""
  try {
    const result = await djangoGetParsed(
      `/internal/v1/product/${encodeURIComponent(productRef)}/${suffix}`,
      productDetailPayloadSchema
    )
    return result.item
  } catch (cause) {
    if (cause instanceof BackendRequestError && cause.status === 404)
      return null
    throw cause
  }
}

export async function browseRecipeHealth(query: BrowseQuery = {}): Promise<
  BrowseResult<RecipeHealth> & {
    categories: Array<{ id: string; label: string }>
    hasAnyRecipe: boolean
    currencyCode: CurrencyCode
    facets: RecipeFacets
  }
> {
  return djangoGet(browsePath("/internal/v1/recipe-health/", query))
}

/** Metadata browse used by the normalized recipe workspace. It is separate
 * from recipe-health so collaborators never need a pricing read. */
export async function browseRecipes(query: BrowseQuery = {}) {
  return djangoGetParsed(
    browsePath("/internal/v1/recipes/", query),
    recipesPayloadSchema
  )
}

export async function getDashboardOverview(): Promise<DashboardOverview> {
  return djangoGet("/internal/v1/dashboard-overview/")
}

export async function getSearchIndex(query = "") {
  const suffix = query ? `?q=${encodeURIComponent(query.slice(0, 200))}` : ""
  const result = await djangoGetParsed(
    `/internal/v1/search-index/${suffix}`,
    searchIndexPayloadSchema
  )
  return result.items
}

export async function getRecipe(recipeId: string) {
  const result = await djangoGetParsed(
    `/internal/v1/recipes/${encodeURIComponent(recipeId)}/`,
    recipePayloadSchema
  )
  return result.item
}

export async function getRecipeCostDiff(
  recipeRef: string,
  from?: string
): Promise<RecipeCostDiff | null> {
  const search = from ? `?${new URLSearchParams({ from })}` : ""
  try {
    const result = await djangoGetParsed(
      `/internal/v1/recipes/${encodeURIComponent(recipeRef)}/cost-diff/${search}`,
      recipeCostDiffPayloadSchema
    )
    return result.item
  } catch (cause) {
    if (cause instanceof BackendRequestError && cause.status === 404)
      return null
    throw cause
  }
}

/** The read-only recipe behind a guest share token; null when it is unknown. */
export async function getGuestRecipe(token: string) {
  try {
    const result = await djangoGetParsed(
      `/internal/v1/guest/recipes/${encodeURIComponent(token)}/`,
      guestRecipePayloadSchema
    )
    return result.item
  } catch (cause) {
    if (cause instanceof BackendRequestError && cause.status === 404)
      return null
    throw cause
  }
}

/** The recipes behind a shared book token; null when it is unknown. */
export async function getGuestBook(token: string) {
  try {
    const result = await djangoGetParsed(
      `/internal/v1/guest/books/${encodeURIComponent(token)}/`,
      guestBookPayloadSchema
    )
    return result.item
  } catch (cause) {
    if (cause instanceof BackendRequestError && cause.status === 404)
      return null
    throw cause
  }
}

/** The label preview rollup for one recipe, viewer-safe. */
export async function getRecipeNutrition(recipeId: string) {
  const result = await djangoGetParsed(
    `/internal/v1/recipes/${encodeURIComponent(recipeId)}/nutrition/`,
    recipeNutritionPayloadSchema
  )
  return result.item
}

export const getBusinessSettings = cache(
  async (): Promise<BusinessSettings> => {
    const result = await djangoGet<BusinessSettings>(
      "/internal/v1/business-settings/"
    )
    return {
      ...result,
      foodCostTarget: resolveFoodCostTarget(result.foodCostTarget),
      overtimeWeeklyMinutes: resolveOvertimeWeeklyMinutes(
        result.overtimeWeeklyMinutes
      ),
      payrollTaxPercent: resolvePayrollTaxPercent(result.payrollTaxPercent),
      unpaidBreakMinutes: resolveUnpaidBreakMinutes(result.unpaidBreakMinutes),
      unpaidBreakPerHours: resolveUnpaidBreakPerHours(
        result.unpaidBreakPerHours
      ),
      productMatching: resolveProductMatching(result.productMatching),
      timezone: resolveTimezone(result.timezone),
    }
  }
)

/** The kitchen's members and the invites still waiting to be claimed. */
export async function getKitchenMembers() {
  return djangoGetParsed(
    "/internal/v1/kitchen-members/",
    kitchenMembersPayloadSchema
  )
}

export async function getMenus(): Promise<MenusPayload> {
  return djangoGet<MenusPayload>("/internal/v1/menus/")
}

export async function getMenu(ref: string): Promise<MenuDetail | null> {
  try {
    return await djangoGet<MenuDetail>(
      `/internal/v1/menu/${encodeURIComponent(ref)}/`
    )
  } catch (cause) {
    if (cause instanceof BackendRequestError && cause.status === 404)
      return null
    throw cause
  }
}

export async function getMenuForecast(
  ref: string,
  days: 7 | 30 = 7,
  plan: MenuForecastPlan = "typical"
): Promise<MenuForecast | null> {
  const query = new URLSearchParams({ days: String(days), plan })
  try {
    return await djangoGetParsed(
      `/internal/v1/menu/${encodeURIComponent(ref)}/forecast/?${query}`,
      menuForecastPayloadSchema
    )
  } catch (cause) {
    if (cause instanceof BackendRequestError && cause.status === 404)
      return null
    throw cause
  }
}

export async function getMenuSources(): Promise<MenuSources> {
  return djangoGet<MenuSources>("/internal/v1/menu-sources/")
}

/**
 * The workspace history, newest first. `before` is the cursor the previous
 * page returned; `events` and `types` narrow it, and both go over as csv.
 */
export async function listActivity(
  params: {
    before?: string
    events?: readonly ActivityEventKind[]
    types?: readonly ActivityResourceType[]
    /** One resource's own history, e.g. everything logged for an invoice. */
    resourceId?: string
    limit?: number
  } = {}
): Promise<ActivityPayload> {
  const search = new URLSearchParams()
  if (params.before) search.set("before", params.before)
  if (params.resourceId) search.set("resourceId", params.resourceId)
  if (params.events?.length) search.set("events", params.events.join(","))
  if (params.types?.length) search.set("types", params.types.join(","))
  if (params.limit) search.set("limit", String(params.limit))
  const suffix = search.size ? `?${search}` : ""
  return djangoGetParsed(
    `/internal/v1/activity/${suffix}`,
    activityPayloadSchema
  )
}

export async function listPrimoConversations(
  params: {
    page?: number
    limit?: number
    archived?: boolean
    query?: string
  } = {}
): Promise<PrimoConversationList> {
  const search = new URLSearchParams({
    archived: params.archived ? "1" : "0",
  })
  if (params.query) search.set("q", params.query)
  if (params.page) search.set("page", String(params.page))
  if (params.limit) search.set("limit", String(params.limit))
  return djangoGetParsed(
    `/internal/v1/primo/conversations/?${search}`,
    primoConversationListSchema
  )
}

export async function getPrimoConversation(
  id: string
): Promise<PrimoConversation | null> {
  try {
    const result = await djangoGetParsed(
      `/internal/v1/primo/conversations/${encodeURIComponent(id)}/`,
      primoConversationSchema
    )
    return result.item
  } catch (cause) {
    if (cause instanceof BackendRequestError && cause.status === 404)
      return null
    throw cause
  }
}
