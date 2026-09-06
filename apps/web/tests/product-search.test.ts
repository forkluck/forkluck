import { describe, expect, it } from "vitest"

import type { SalesProductRow } from "../lib/backend/types"
import { matchesProductSearch, productSkus } from "../lib/product-search"

function product(overrides: Partial<SalesProductRow> = {}): SalesProductRow {
  return {
    id: "product-1",
    publicId: "prd_000000000001",
    editVersion: 0,
    name: "Pineapple Linzer",
    normalizedName: "pineapple linzer",
    sku: "",
    skus: [],
    description: "",
    sellPriceCents: 0,
    baseUnit: "",
    category: "",
    isActive: true,
    costed: false,
    components: [],
    recipeLinks: [],
    variants: [
      {
        id: "variant-1",
        channel: "square",
        providerAccountId: "merchant-1",
        matchKey: "square:item:one",
        sku: "200120",
        externalName: "Pineapple Linzer",
        externalVariantTitle: "",
        identityKind: "item",
        externalObjectId: "one",
        productExternalObjectId: "",
        quantityMultiplier: 1,
        attributionPercent: null,
      },
      {
        id: "variant-2",
        channel: "shopify",
        providerAccountId: "shop.example",
        matchKey: "shopify:item:two",
        sku: "LINZER-PINE",
        externalName: "Pineapple Linzer",
        externalVariantTitle: "",
        identityKind: "item",
        externalObjectId: "two",
        productExternalObjectId: "",
        quantityMultiplier: 1,
        attributionPercent: null,
      },
    ],
    sales: {
      lineCount: 0,
      quantity: 0,
      totalQuantity: 0,
      grossCents: 0,
      discountCents: 0,
      netSalesCents: 0,
      attributedNetSalesCents: 0,
      taxCents: 0,
      refundCents: 0,
      sharedToMembers: false,
      asSoldNetSalesCents: 0,
      splitBasis: null,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe("product association search", () => {
  it("finds products by title or any SKU", () => {
    const row = product()

    expect(matchesProductSearch(row, "pineapple linzer")).toBe(true)
    expect(matchesProductSearch(row, "200120")).toBe(true)
    expect(matchesProductSearch(row, "linzer-pine")).toBe(true)
    expect(matchesProductSearch(row, "raspberry")).toBe(false)
  })

  it("deduplicates SKUs shown beneath a product", () => {
    const row = product({
      variants: [
        ...product().variants,
        { ...product().variants[0]!, id: "variant-3" },
      ],
    })

    expect(productSkus(row)).toEqual(["200120", "LINZER-PINE"])
  })
})
