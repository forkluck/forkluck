import { describe, expect, it } from "vitest"

import type {
  SalesModifierReviewItem,
  SalesReviewCategory,
  SalesReviewItem,
} from "../lib/backend/types"
import {
  filterModifierRows,
  filterReviewItems,
  groupModifiersByParent,
  groupReviewItemsByCategory,
  modifierGroupSummary,
  reviewGroupSummary,
} from "../lib/sales-review-groups"

function item(overrides: Partial<SalesReviewItem> = {}): SalesReviewItem {
  return {
    channel: "square",
    providerAccountId: "square-merchant",
    matchKey: "square:item:VAR1",
    externalObjectId: "VAR1",
    productExternalObjectId: "",
    sku: "1001",
    itemName: "Tea Flight",
    externalVariantTitle: "",
    lineCount: 2,
    quantity: 2,
    orderSources: ["Point of Sale"],
    netSalesCents: 1_000,
    currencyCode: "USD",
    hasModifiers: false,
    category: "Tea",
    lastSoldAt: new Date("2026-01-05T00:00:00Z"),
    suggestedProductId: null,
    suggestedProductName: null,
    suggestionReason: null,
    ...overrides,
  }
}

function modifier(
  overrides: Partial<SalesModifierReviewItem> = {}
): SalesModifierReviewItem {
  return {
    channel: "square",
    providerAccountId: "square-merchant",
    matchKey: "square:modifier:MOD1",
    name: "Honey",
    sku: "",
    externalObjectId: "MOD1",
    parentItemName: "Tea Flight",
    contextLabel: "Tea Flight > Honey",
    usageCount: 3,
    quantity: 3,
    lastSeenAt: null,
    ...overrides,
  }
}

function category(
  overrides: Partial<SalesReviewCategory> = {}
): SalesReviewCategory {
  return {
    channel: "square",
    providerAccountId: "square-merchant",
    category: "Tea",
    keyCount: 120,
    catalogOnlyKeyCount: 0,
    lineCount: 400,
    netSalesCents: 500_000,
    ...overrides,
  }
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

describe("review grouping", () => {
  it("orders groups by net sales and names the uncategorized bucket", () => {
    const groups = groupReviewItemsByCategory(
      [
        item({ matchKey: "a", category: "" }),
        item({ matchKey: "b", category: "Tea" }),
      ],
      [
        category({ category: "", keyCount: 3, netSalesCents: 200 }),
        category({ category: "Tea", keyCount: 120, netSalesCents: 500_000 }),
      ]
    )
    expect(groups.map((group) => group.label)).toEqual(["Tea", "Uncategorized"])
    expect(groups[0]!.category).toBe("Tea")
    expect(groups[1]!.category).toBe("")
  })

  it("takes header counts from the server rollup, not the capped rows", () => {
    const groups = groupReviewItemsByCategory([item()], [category()])
    expect(groups[0]!.items).toHaveLength(1)
    expect(groups[0]!.totalKeyCount).toBe(120)
    expect(groups[0]!.totalLineCount).toBe(400)
    expect(reviewGroupSummary(groups[0]!, money)).toBe(
      "Tea · 120 items · $5000.00"
    )
  })

  it("carries catalog-only counts while sales totals remain zero", () => {
    const groups = groupReviewItemsByCategory(
      [item({ lineCount: 0, quantity: 0, netSalesCents: 0, lastSoldAt: null })],
      [
        category({
          keyCount: 1,
          catalogOnlyKeyCount: 1,
          lineCount: 0,
          netSalesCents: 0,
        }),
      ]
    )
    expect(groups[0]!.catalogOnlyKeyCount).toBe(1)
    expect(groups[0]!.totalLineCount).toBe(0)
  })

  it("falls back to the rendered rows when no rollup covers the bucket", () => {
    const groups = groupReviewItemsByCategory([
      item({ matchKey: "a", category: "Retail", netSalesCents: 250 }),
      item({ matchKey: "b", category: "Retail", netSalesCents: 150 }),
    ])
    expect(groups[0]!.totalKeyCount).toBe(2)
    expect(groups[0]!.totalLineCount).toBe(4)
    expect(groups[0]!.netSalesCents).toBe(400)
  })

  it("keeps the same category on two channels apart", () => {
    const groups = groupReviewItemsByCategory([
      item({ matchKey: "a", channel: "square", category: "Tea" }),
      item({ matchKey: "b", channel: "shopify", category: "Tea" }),
    ])
    expect(groups).toHaveLength(2)
    expect(new Set(groups.map((group) => group.channel))).toEqual(
      new Set(["square", "shopify"])
    )
  })

  it("combines the same category across historical provider accounts", () => {
    const groups = groupReviewItemsByCategory(
      [
        item({ providerAccountId: "merchant-a", matchKey: "square:item:a" }),
        item({ providerAccountId: "merchant-b", matchKey: "square:item:b" }),
      ],
      [
        category({
          providerAccountId: "merchant-a",
          keyCount: 6,
          lineCount: 10,
          netSalesCents: 143_200,
        }),
        category({
          providerAccountId: "merchant-b",
          keyCount: 4,
          lineCount: 8,
          netSalesCents: 132_000,
        }),
      ]
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.providerAccountIds).toEqual(["merchant-a", "merchant-b"])
    expect(groups[0]!.totalKeyCount).toBe(10)
    expect(groups[0]!.totalLineCount).toBe(18)
    expect(groups[0]!.netSalesCents).toBe(275_200)
    expect(groups[0]!.items).toHaveLength(2)
  })

  it("combines uncategorized rows across provider accounts", () => {
    const groups = groupReviewItemsByCategory([
      item({ providerAccountId: "merchant-a", matchKey: "a", category: "" }),
      item({ providerAccountId: "merchant-b", matchKey: "b", category: "" }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.label).toBe("Uncategorized")
    expect(groups[0]!.providerAccountIds).toEqual(["merchant-a", "merchant-b"])
  })

  it("searches across every group, matching name, SKU, and category", () => {
    const rows = [
      item({ matchKey: "a", itemName: "Tea Flight", category: "Tea" }),
      item({
        matchKey: "b",
        itemName: "Tote Bag",
        sku: "7788",
        category: "Retail",
      }),
    ]
    expect(filterReviewItems(rows, "tote")).toHaveLength(1)
    expect(filterReviewItems(rows, "7788")[0]!.itemName).toBe("Tote Bag")
    expect(filterReviewItems(rows, "retail")[0]!.itemName).toBe("Tote Bag")
    expect(filterReviewItems(rows, "   ")).toHaveLength(2)
  })
})

describe("modifier grouping", () => {
  it("groups by parent item, biggest first, and names the orphan bucket", () => {
    const groups = groupModifiersByParent([
      modifier({ matchKey: "a", parentItemName: "" }),
      modifier({ matchKey: "b", parentItemName: "Tea Flight" }),
      modifier({ matchKey: "c", parentItemName: "Tea Flight", name: "Lemon" }),
    ])
    expect(groups.map((group) => group.label)).toEqual([
      "Tea Flight",
      "Any item",
    ])
    expect(modifierGroupSummary(groups[0]!)).toBe("Tea Flight · 2 modifiers")
    expect(modifierGroupSummary(groups[1]!)).toBe("Any item · 1 modifier")
  })

  it("searches modifiers by name and by parent", () => {
    const rows = [
      modifier({ matchKey: "a", name: "Honey" }),
      modifier({
        matchKey: "b",
        name: "Lemon",
        parentItemName: "Cookie",
        contextLabel: "Cookie > Lemon",
      }),
    ]
    expect(filterModifierRows(rows, "cookie")[0]!.name).toBe("Lemon")
    expect(filterModifierRows(rows, "honey")).toHaveLength(1)
    expect(filterModifierRows(rows, "")).toHaveLength(2)
  })
})
