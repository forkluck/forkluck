import type {
  SalesModifierReviewItem,
  SalesReviewCategory,
  SalesReviewItem,
} from "@/lib/backend/types"

/** What an uncategorized POS item is called in the queue. */
export const NO_CATEGORY_LABEL = "Uncategorized"
/** What a modifier with no parent item is called in the queue. */
export const ANY_PARENT_LABEL = "Any item"

export type ReviewCategoryGroup = {
  /** Stable per channel+category; safe as a React key and an open/closed id. */
  id: string
  channel: "square" | "shopify"
  /** Every provider connection represented by this display bucket. */
  providerAccountIds: string[]
  /** The raw value the ignore action takes — "" for uncategorized. */
  category: string
  label: string
  /** The rows this payload carries, already filtered by the search box. */
  items: SalesReviewItem[]
  /** Every pending identity in the bucket server-side, capped list or not. */
  totalKeyCount: number
  catalogOnlyKeyCount: number
  totalLineCount: number
  netSalesCents: number
}

export type ModifierGroup = {
  id: string
  label: string
  rows: SalesModifierReviewItem[]
}

function categoryId(channel: string, category: string) {
  // A NUL separator can't appear in either half, so ids never collide.
  return `${channel}\u0000${category}`
}

function matches(haystack: string[], needle: string) {
  const query = needle.trim().toLowerCase()
  if (!query) return true
  return haystack.some((value) => value.toLowerCase().includes(query))
}

/** The queue's one search box: applied before grouping, so it spans groups. */
export function filterReviewItems(items: SalesReviewItem[], query: string) {
  if (!query.trim()) return items
  return items.filter((item) =>
    matches(
      [item.itemName, item.externalVariantTitle, item.sku, item.category],
      query
    )
  )
}

export function filterModifierRows(
  rows: SalesModifierReviewItem[],
  query: string
) {
  if (!query.trim()) return rows
  return rows.filter((row) =>
    matches([row.name, row.parentItemName, row.sku, row.contextLabel], query)
  )
}

/**
 * Groups the rendered rows by channel plus provider category/type. Historical
 * provider connections are deliberately folded together: the provider account
 * is identity scope, not useful review information. Headline counts come from
 * every matching server rollup because the rendered list is capped at 200.
 */
export function groupReviewItemsByCategory(
  items: SalesReviewItem[],
  categories: SalesReviewCategory[] = []
): ReviewCategoryGroup[] {
  const groups = new Map<string, ReviewCategoryGroup>()
  const rollups = new Map<
    string,
    Pick<
      ReviewCategoryGroup,
      | "channel"
      | "category"
      | "providerAccountIds"
      | "totalKeyCount"
      | "catalogOnlyKeyCount"
      | "totalLineCount"
      | "netSalesCents"
    >
  >()
  for (const entry of categories) {
    const id = categoryId(entry.channel, entry.category)
    const rollup = rollups.get(id)
    if (rollup) {
      if (!rollup.providerAccountIds.includes(entry.providerAccountId)) {
        rollup.providerAccountIds.push(entry.providerAccountId)
      }
      rollup.totalKeyCount += entry.keyCount
      rollup.catalogOnlyKeyCount += entry.catalogOnlyKeyCount
      rollup.totalLineCount += entry.lineCount
      rollup.netSalesCents += entry.netSalesCents
    } else {
      rollups.set(id, {
        channel: entry.channel,
        category: entry.category,
        providerAccountIds: [entry.providerAccountId],
        totalKeyCount: entry.keyCount,
        catalogOnlyKeyCount: entry.catalogOnlyKeyCount,
        totalLineCount: entry.lineCount,
        netSalesCents: entry.netSalesCents,
      })
    }
  }

  for (const item of items) {
    const category = item.category ?? ""
    const id = categoryId(item.channel, category)
    let group = groups.get(id)
    if (!group) {
      const rollup = rollups.get(id)
      group = {
        id,
        channel: item.channel,
        providerAccountIds: rollup?.providerAccountIds.slice() ?? [
          item.providerAccountId,
        ],
        category,
        label: category || NO_CATEGORY_LABEL,
        items: [],
        totalKeyCount: rollup?.totalKeyCount ?? 0,
        catalogOnlyKeyCount: rollup?.catalogOnlyKeyCount ?? 0,
        totalLineCount: rollup?.totalLineCount ?? 0,
        netSalesCents: rollup?.netSalesCents ?? 0,
      }
      groups.set(id, group)
    } else if (!group.providerAccountIds.includes(item.providerAccountId)) {
      group.providerAccountIds.push(item.providerAccountId)
    }
    group.items.push(item)
  }

  // A category the rollup never mentioned (or a rollup that lags a payload)
  // still needs honest numbers, so fall back to what is on screen.
  for (const group of groups.values()) {
    group.providerAccountIds.sort()
    if (!group.totalKeyCount) group.totalKeyCount = group.items.length
    if (!group.totalLineCount) {
      group.totalLineCount = group.items.reduce(
        (sum, item) => sum + item.lineCount,
        0
      )
    }
    if (!group.netSalesCents) {
      group.netSalesCents = group.items.reduce(
        (sum, item) => sum + item.netSalesCents,
        0
      )
    }
  }

  return [...groups.values()].sort(
    (a, b) =>
      b.netSalesCents - a.netSalesCents ||
      b.totalKeyCount - a.totalKeyCount ||
      a.label.localeCompare(b.label)
  )
}

/** Modifiers read as a list under the item they were chosen on. */
export function groupModifiersByParent(
  rows: SalesModifierReviewItem[]
): ModifierGroup[] {
  const groups = new Map<string, ModifierGroup>()
  for (const row of rows) {
    const label = row.parentItemName || ANY_PARENT_LABEL
    const id = `${row.channel}\u0000${row.providerAccountId}\u0000${label}`
    let group = groups.get(id)
    if (!group) {
      group = { id, label, rows: [] }
      groups.set(id, group)
    }
    group.rows.push(row)
  }
  return [...groups.values()].sort(
    (a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label)
  )
}

/** "Loose Leaf Tea · 128 items · $4,210.00" */
export function reviewGroupSummary(
  group: ReviewCategoryGroup,
  formatMoney: (cents: number) => string
) {
  const count = group.totalKeyCount
  return `${group.label} · ${count} ${count === 1 ? "item" : "items"} · ${formatMoney(
    group.netSalesCents
  )}`
}

/** "Tea Flight · 6 modifiers" */
export function modifierGroupSummary(group: ModifierGroup) {
  const count = group.rows.length
  return `${group.label} · ${count} ${count === 1 ? "modifier" : "modifiers"}`
}
