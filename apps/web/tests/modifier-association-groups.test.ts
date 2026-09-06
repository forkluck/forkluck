import { describe, expect, it } from "vitest"

import type {
  SalesModifierCatalogList,
  SalesModifierCatalogRecord,
} from "../lib/backend/types"
import {
  MIXED_MODIFIER_ASSOCIATION,
  groupModifierAssociations,
} from "../lib/modifier-association-groups"

function record(
  overrides: Partial<SalesModifierCatalogRecord> = {}
): SalesModifierCatalogRecord {
  return {
    channel: "square",
    providerAccountId: "merchant",
    matchKey: "square:modifier:PARENT:OLD",
    name: "Pineapple Linzer (200120)",
    sku: "",
    externalObjectId: "OLD",
    parentItemName: "Snack Flight",
    contextLabel: "Snack Flight > Pineapple Linzer (200120)",
    usageCount: 4,
    quantity: 4,
    lastSeenAt: "2026-07-01T00:00:00Z",
    variantId: null,
    productId: null,
    productName: null,
    quantityMultiplier: 1,
    ...overrides,
  }
}

function modifierList(): SalesModifierCatalogList {
  return {
    id: "list-1",
    channel: "square",
    providerAccountId: "merchant",
    externalObjectId: "LIST",
    name: "Snack Flight",
    modifierType: "list",
    selectionType: "multiple",
    allowQuantities: false,
    minSelected: 3,
    maxSelected: 3,
    mappedCount: 1,
    options: [
      {
        id: "option-1",
        externalObjectId: "CURRENT-1",
        name: "Pineapple Linzer (200120)",
        ordinal: 1,
        priceCents: 0,
        currencyCode: "USD",
        variantId: "variant-1",
        productId: "product-1",
        productName: "Pineapple Linzer",
        quantityMultiplier: 1,
      },
      {
        id: "option-2",
        externalObjectId: "CURRENT-2",
        name: "Pineapple Linzer (200120)",
        ordinal: 2,
        priceCents: 0,
        currencyCode: "USD",
        variantId: null,
        productId: null,
        productName: null,
        quantityMultiplier: 1,
      },
    ],
    records: [record()],
  }
}

describe("modifier association groups", () => {
  it("combines repeated current and historical Square ids by visible name", () => {
    const [group] = groupModifierAssociations(modifierList())

    expect(group?.name).toBe("Pineapple Linzer (200120)")
    expect(group?.options).toHaveLength(2)
    expect(group?.records).toHaveLength(1)
    expect(group?.squareRecordCount).toBe(3)
    expect(group?.usageCount).toBe(4)
  })

  it("prefills the one known product and flags incomplete aliases", () => {
    const [group] = groupModifierAssociations(modifierList())

    expect(group?.initialSelection).toBe("product-1")
    expect(group?.needsNormalization).toBe(true)
  })

  it("does not guess when duplicate records disagree", () => {
    const list = modifierList()
    list.options[1]!.productId = "product-2"

    const [group] = groupModifierAssociations(list)
    expect(group?.initialSelection).toBe(MIXED_MODIFIER_ASSOCIATION)
  })

  it("does not merge similar labels with different SKUs", () => {
    const list = modifierList()
    list.records.push(
      record({
        matchKey: "square:modifier:PARENT:OTHER",
        externalObjectId: "OTHER",
        name: "Pineapple Linzer (200121)",
      })
    )

    expect(groupModifierAssociations(list)).toHaveLength(2)
  })
})
