/** What a browser keeps of an edit the server has not accepted yet. */
const SCHEMA = 1
const PREFIX = `fl.draft.v${SCHEMA}.`
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_DRAFTS = 20
/** How often a dirty screen is allowed to write its draft. */
const THROTTLE_MS = 5000

export type DraftKind = "recipe" | "menu" | "invoice"

export type DraftSlot = {
  workspaceId: string
  userId: string
  kind: DraftKind
  /** The saved record's id, or `new:<uuid>` for one that has never saved. */
  id: string
}

/** The schema version lives in the key prefix, not in here. */
export type Draft = {
  payload: unknown
  savedAt: number
}

export function draftKey({ workspaceId, userId, kind, id }: DraftSlot): string {
  return `${PREFIX}${workspaceId}.${userId}.${kind}.${id}`
}

/** Writes at most once every five seconds, evicting to make room. */
export function writeDraft(key: string, payload: unknown): void {
  const now = Date.now()
  const stored = window.localStorage.getItem(key)
  if (
    stored !== null &&
    now - (JSON.parse(stored) as Draft).savedAt < THROTTLE_MS
  )
    return
  const draft: Draft = { payload, savedAt: now }
  const value = JSON.stringify(draft)
  while (stored === null && keys().length >= MAX_DRAFTS) {
    if (!evictOldest(key)) break
  }
  for (;;) {
    try {
      window.localStorage.setItem(key, value)
      return
    } catch {
      if (!evictOldest(key)) return
    }
  }
}

/** The draft kept for this slot, unless it has gone stale. */
export function readDraft(key: string): Draft | null {
  const raw = window.localStorage.getItem(key)
  if (raw === null) return null
  const draft = JSON.parse(raw) as Draft
  if (Date.now() - draft.savedAt > TTL_MS) {
    clearDraft(key)
    return null
  }
  return draft
}

export function clearDraft(key: string): void {
  window.localStorage.removeItem(key)
}

/** Signing out takes this user's drafts with it, in every workspace. */
export function clearDraftsForUser(userId: string): void {
  const primoKeys: string[] = []
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index)
    if (
      key?.startsWith(`primo:draft-v2:${userId}:`) ||
      key === `primo:active:${userId}` ||
      key === `primo:unsent:${userId}`
    )
      primoKeys.push(key!)
  }
  primoKeys.forEach((key) => window.localStorage.removeItem(key))
  for (const key of keys()) {
    if (key.slice(PREFIX.length).split(".")[1] === userId) clearDraft(key)
  }
}

function keys(): string[] {
  const found: string[] = []
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (key?.startsWith(PREFIX)) found.push(key)
  }
  return found
}

/** Drops the oldest draft that is not the one being written. Says if it did. */
function evictOldest(keep: string): boolean {
  let oldest: string | null = null
  let oldestAt = Infinity
  for (const key of keys()) {
    if (key === keep) continue
    const raw = window.localStorage.getItem(key)
    const savedAt = raw === null ? 0 : ((JSON.parse(raw) as Draft).savedAt ?? 0)
    if (savedAt < oldestAt) {
      oldest = key
      oldestAt = savedAt
    }
  }
  if (oldest === null) return false
  clearDraft(oldest)
  return true
}

type RecipeDraft = {
  title: string
  description: string
  items: readonly unknown[]
  steps: readonly unknown[]
  batchSizes: readonly unknown[]
  equivalency: unknown
  tags: readonly string[]
}

/** The recipe fields worth recovering, and nothing else. */
export function recipeDraft(values: RecipeDraft): RecipeDraft {
  return {
    title: values.title,
    description: values.description,
    items: values.items,
    steps: values.steps,
    batchSizes: values.batchSizes,
    equivalency: values.equivalency,
    tags: values.tags,
  }
}

type MenuDraft = {
  name: string
  periodStart: string | null
  periodEnd: string | null
  items: readonly unknown[]
}

/** The menu fields worth recovering, and nothing else. */
export function menuDraft(values: MenuDraft): MenuDraft {
  return {
    name: values.name,
    periodStart: values.periodStart,
    periodEnd: values.periodEnd,
    items: values.items,
  }
}

type InvoiceDraft = {
  supplierName: string
  invoiceDate: string
  dueDate: string
  invoiceNumber: string
  paymentMethod: string
  subtotal: string
  tax: string
  total: string
  notes: string
  lines: readonly unknown[]
}

/** The invoice fields worth recovering, and nothing else. */
export function invoiceDraft(values: InvoiceDraft): InvoiceDraft {
  return {
    supplierName: values.supplierName,
    invoiceDate: values.invoiceDate,
    dueDate: values.dueDate,
    invoiceNumber: values.invoiceNumber,
    paymentMethod: values.paymentMethod,
    subtotal: values.subtotal,
    tax: values.tax,
    total: values.total,
    notes: values.notes,
    lines: values.lines,
  }
}
