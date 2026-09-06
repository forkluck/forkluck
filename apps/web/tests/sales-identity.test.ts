import { describe, expect, it } from "vitest"

import type { SalesProductVariantRow } from "../lib/backend/types"
import {
  bundleMembersValidationError,
  connectedIdentityGroups,
  identityRowSummary,
  identitySummary,
  modifierContextLabel,
  modifierUsageLabel,
  parseAttributionPercent,
  parseMemberQuantity,
  parseMultiplier,
  preselectedCandidateId,
  salesIdentityKey,
  salesVariantPayload,
  suggestedProduct,
} from "../lib/sales-identity"

function member(productId: string, quantity = 1) {
  return { productId, quantity }
}

function variant(
  overrides: Partial<SalesProductVariantRow> = {}
): SalesProductVariantRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    channel: "square",
    providerAccountId: "square-merchant",
    matchKey: "square:item:VAR1",
    sku: "200120",
    externalName: "Burger",
    externalVariantTitle: "Large",
    identityKind: "item",
    externalObjectId: "VAR1",
    productExternalObjectId: "",
    quantityMultiplier: 1,
    attributionPercent: null,
    ...overrides,
  }
}

describe("sales identity rows", () => {
  it("validates a box's products at the dialog boundary", () => {
    expect(bundleMembersValidationError([member("a"), member("b")])).toBeNull()
    expect(bundleMembersValidationError([])).toContain("2 and 50")
    expect(bundleMembersValidationError([member("a")])).toContain("2 and 50")
    expect(bundleMembersValidationError([member("a"), member("a")])).toContain(
      "twice"
    )
    expect(
      bundleMembersValidationError(
        Array.from({ length: 50 }, (_, index) => member(String(index)))
      )
    ).toBeNull()
    expect(
      bundleMembersValidationError(
        Array.from({ length: 51 }, (_, index) => member(String(index)))
      )
    ).toContain("2 and 50")
  })

  it("rejects box units that are not whole and positive", () => {
    expect(
      bundleMembersValidationError([member("a", 4), member("b", 6)])
    ).toBeNull()
    expect(
      bundleMembersValidationError([member("a", 0), member("b", 6)])
    ).toContain("whole units")
    expect(
      bundleMembersValidationError([member("a", 1.5), member("b", 6)])
    ).toContain("whole units")
  })

  it("reads member units and attribution the way the backend does", () => {
    expect(parseMemberQuantity("4")).toEqual({ ok: true, value: 4 })
    expect(parseMemberQuantity("0")).toMatchObject({ ok: false })
    expect(parseMemberQuantity("1.5")).toMatchObject({ ok: false })
    expect(parseMemberQuantity("")).toMatchObject({ ok: false })
    expect(parseAttributionPercent("80")).toEqual({ ok: true, value: 80 })
    expect(parseAttributionPercent("0")).toEqual({ ok: true, value: 0 })
    expect(parseAttributionPercent("100")).toEqual({ ok: true, value: 100 })
    expect(parseAttributionPercent("101")).toMatchObject({ ok: false })
    expect(parseAttributionPercent("-1")).toMatchObject({ ok: false })
    expect(parseAttributionPercent("12.5")).toMatchObject({ ok: false })
  })

  it("shows provider, type, name, SKU, and multiplier", () => {
    expect(identityRowSummary(variant({ quantityMultiplier: 12 }))).toBe(
      "Square · Item · Burger · Large · SKU 200120 · ×12"
    )
  })

  it("labels a modifier identity without inventing a SKU", () => {
    expect(
      identityRowSummary(
        variant({
          identityKind: "modifier",
          sku: "",
          externalName: "Extra Cheese",
          externalVariantTitle: "",
        })
      )
    ).toBe("Square · Modifier · Extra Cheese · ×1")
  })

  it("accepts positive decimals and rejects zero or negative units", () => {
    expect(parseMultiplier("12")).toEqual({ ok: true, value: 12 })
    expect(parseMultiplier(" 0.125 ")).toEqual({ ok: true, value: 0.125 })
    expect(parseMultiplier("0").ok).toBe(false)
    expect(parseMultiplier("-1").ok).toBe(false)
    expect(parseMultiplier("").ok).toBe(false)
    expect(parseMultiplier("many").ok).toBe(false)
    expect(parseMultiplier("1000001").ok).toBe(false)
    expect(parseMultiplier("1000000")).toEqual({ ok: true, value: 1_000_000 })
  })

  it("summarizes identity counts and non-default multipliers", () => {
    expect(identitySummary([])).toBe("")
    expect(identitySummary([variant()])).toBe("1 identity")
    expect(
      identitySummary([variant(), variant({ quantityMultiplier: 12 })])
    ).toBe("2 identities · ×1, ×12")
  })

  it("groups a shared SKU across channels while preserving provider identities", () => {
    const groups = connectedIdentityGroups([
      variant(),
      variant({
        channel: "shopify",
        id: "shopify-variant",
        quantityMultiplier: 12,
      }),
      variant({
        id: "second-square-variant",
        externalVariantTitle: "Medium",
      }),
      variant({
        id: "modifier-variant",
        identityKind: "modifier",
        sku: "",
        externalName: "Extra cheese",
        externalVariantTitle: "",
      }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      indexes: [0, 1, 2],
      channels: ["square", "shopify"],
      sku: "200120",
    })
    expect(groups[1]).toMatchObject({
      indexes: [3],
      channels: ["square"],
      identityKind: "modifier",
    })
  })

  it("keys equal provider objects separately for different accounts", () => {
    expect(
      salesIdentityKey({
        channel: "square",
        providerAccountId: "merchant-a",
        matchKey: "square:item:2200",
      })
    ).not.toBe(
      salesIdentityKey({
        channel: "square",
        providerAccountId: "merchant-b",
        matchKey: "square:item:2200",
      })
    )
  })

  it("preserves exact provider IDs in the save payload", () => {
    const payload = salesVariantPayload(
      {
        id: null,
        channel: "shopify",
        providerAccountId: "shop.example",
        matchKey: "shopify:item:gid://shopify/ProductVariant/2200",
        identityKind: "item",
        sku: " 2200 ",
        externalName: " Cookie ",
        externalVariantTitle: " Box ",
        externalObjectId: "gid://shopify/ProductVariant/2200",
        productExternalObjectId: "gid://shopify/Product/22",
      },
      1,
      null
    )

    expect(payload).toMatchObject({
      providerAccountId: "shop.example",
      matchKey: "shopify:item:gid://shopify/ProductVariant/2200",
      sku: "2200",
      externalObjectId: "gid://shopify/ProductVariant/2200",
      productExternalObjectId: "gid://shopify/Product/22",
    })
    // A box is a product with components,
    // so the identity payload names neither a kind nor members.
    expect(payload).not.toHaveProperty("kind")
    expect(payload).not.toHaveProperty("members")
  })

  it("selects only the product named by a provider-identity suggestion", () => {
    const products = [{ id: "existing", name: "Cookie" }]
    expect(suggestedProduct(products, "existing")).toBe(products[0])
    expect(suggestedProduct(products, "missing")).toBeNull()
    expect(suggestedProduct(products, null)).toBeNull()
  })
})

describe("pending modifier review rows", () => {
  it("shows Parent > Modifier context", () => {
    expect(
      modifierContextLabel({
        contextLabel: "Sampler > Chocolate Cookie",
        name: "Chocolate Cookie",
        quantity: 1,
      })
    ).toBe("Sampler > Chocolate Cookie")
  })

  it("appends the quantity once a selection repeats", () => {
    expect(
      modifierContextLabel({
        contextLabel: "Burger > Extra Cheese",
        name: "Extra Cheese",
        quantity: 2,
      })
    ).toBe("Burger > Extra Cheese × 2")
  })

  it("falls back to the modifier name when there is no parent", () => {
    expect(
      modifierContextLabel({ contextLabel: "", name: "Oat Milk", quantity: 1 })
    ).toBe("Oat Milk")
  })

  it("reports usage and last seen", () => {
    expect(
      modifierUsageLabel(
        { usageCount: 1, lastSeenAt: "2026-03-03T00:00:00+00:00" },
        () => "Mar 3, 2026"
      )
    ).toBe("1 sale · last seen Mar 3, 2026")
    expect(
      modifierUsageLabel({ usageCount: 4, lastSeenAt: null }, () => "never")
    ).toBe("4 sales")
  })

  it("never preselects a candidate when the suggestion is ambiguous", () => {
    expect(preselectedCandidateId([{ id: "a" }])).toBe("a")
    expect(preselectedCandidateId([{ id: "a" }, { id: "b" }])).toBeNull()
    expect(preselectedCandidateId([])).toBeNull()
  })
})
