import { describe, expect, it } from "vitest"

import {
  dailySalesSchema,
  ingredientSummarySchema,
  menuDetailPayloadSchema,
  menuForecastPayloadSchema,
  periodProductSalesSchema,
  productComponentSchema,
  productDetailSalesSchema,
  productSkuSchema,
} from "@/lib/backend/schemas"

describe("ledger sales schema", () => {
  it("accepts manual count-only daily and product rows", () => {
    expect(
      dailySalesSchema.parse({
        id: "manual-line-1",
        channel: "manual",
        soldOn: "2026-08-27",
        productId: "22222222-2222-4222-8222-222222222222",
        productName: "Maple Tart",
        sku: "TART-MAPLE",
        itemName: "Maple Tart",
        quantity: 3,
        grossCents: 0,
        discountCents: 0,
        netSalesCents: null,
        taxCents: 0,
        refundCents: 0,
        currencyCode: "USD",
      }).netSalesCents
    ).toBeNull()

    expect(
      periodProductSalesSchema.parse({
        productId: "22222222-2222-4222-8222-222222222222",
        productName: "Maple Tart",
        channel: "manual",
        quantity: 3,
        netSalesCents: null,
      }).channel
    ).toBe("manual")
  })
})

describe("product sales stats schema", () => {
  const base = {
    lineCount: 2,
    quantity: 4,
    totalQuantity: 4,
    grossCents: 0,
    discountCents: 0,
    netSalesCents: 0,
    attributedNetSalesCents: 0,
    taxCents: 0,
    refundCents: 0,
    dailySales: [],
    manualSales: [],
  }

  it("reads a bundle row as zero money shared to its members", () => {
    // Regression: money never went nullable, so every sum stayed correct.
    const stats = productDetailSalesSchema.parse({
      ...base,
      sharedToMembers: true,
      asSoldNetSalesCents: 4800,
      splitBasis: "count",
    })

    expect(stats.netSalesCents).toBe(0)
    expect(stats.asSoldNetSalesCents).toBe(4800)
    expect(stats.splitBasis).toBe("count")
  })

  it("defaults the bundle keys a backend deployed behind us omits", () => {
    const stats = productDetailSalesSchema.parse(base)

    expect(stats.sharedToMembers).toBe(false)
    expect(stats.asSoldNetSalesCents).toBe(0)
    expect(stats.splitBasis).toBeNull()
  })

  it("defaults sharedToMembers on a period row", () => {
    expect(
      periodProductSalesSchema.parse({
        productId: "22222222-2222-4222-8222-222222222222",
        productName: "Maple Tart",
        channel: "square",
        quantity: 1,
        netSalesCents: 100,
      }).sharedToMembers
    ).toBe(false)
  })
})

describe("product component schema", () => {
  const base = {
    id: "cmp-1",
    recipeId: null,
    recipePublicId: null,
    recipeName: null,
    ingredientId: null,
    ingredientPublicId: null,
    ingredientName: null,
    productId: null,
    productPublicId: null,
    productName: null,
    quantity: 3,
    unit: "",
    position: 0,
    nonEdible: false,
  }

  it("reads a product component", () => {
    expect(
      productComponentSchema.parse({
        ...base,
        productId: "11111111-1111-4111-8111-111111111111",
        productPublicId: "prd_box",
        productName: "Mooncake Box",
      }).productName
    ).toBe("Mooncake Box")
  })

  it("rejects a component missing the product keys", () => {
    const withoutProduct = { ...base }
    delete (withoutProduct as { productId?: string | null }).productId
    expect(productComponentSchema.safeParse(withoutProduct).success).toBe(false)
  })
})

describe("product SKU schema", () => {
  it("reads a pack SKU with its units per sale", () => {
    expect(
      productSkuSchema.parse({
        id: "sku-1",
        sku: "COOKIE-6",
        quantityMultiplier: 6,
        position: 1,
      }).quantityMultiplier
    ).toBe(6)
  })

  it("rejects the old normalized key", () => {
    expect(
      productSkuSchema.safeParse({
        id: "sku-1",
        sku: "COOKIE-6",
        normalizedSku: "cookie-6",
        quantityMultiplier: 6,
        position: 1,
      }).success
    ).toBe(false)
  })
})

describe("menu forecast horizon", () => {
  const payload = {
    menu: { id: "menu-1", publicId: "mnu_1", name: "Winter" },
    basis: {
      timezone: "UTC",
      historyStart: "2026-08-01",
      historyEnd: "2026-08-28",
      horizonStart: "2026-08-29",
      horizonEnd: "2026-09-27",
      horizonDays: 30,
      historyWeeks: 8,
      plan: "busy",
      seasonalAdjustment: false,
      compositionBasis: "current",
      weeks: {
        recent: [
          {
            start: "2026-08-22",
            end: "2026-08-28",
            units: 12,
            lastYearUnits: 10,
          },
        ],
        horizon: [
          {
            start: "2026-08-29",
            end: "2026-09-04",
            typicalUnits: 12,
            plannedUnits: 18,
            lastYearUnits: 10,
          },
        ],
      },
      level: { weeklyUnits: 12, seasonalFactor: 1, seasonalProducts: 0 },
    },
    coverage: {
      menuItems: 1,
      linkedMenuItems: 1,
      unresolvedMenuItems: 0,
      products: 1,
      productsWithHistory: 1,
      productsWithoutHistory: 0,
      inactiveProducts: 0,
      unresolvedPaths: 0,
    },
    revenue: {
      currencyCode: "USD",
      typicalCents: 5400,
      busyCents: 8100,
      plannedCents: 8100,
      pricedProducts: 1,
      unpricedProducts: 0,
    },
    production: {
      typicalUnits: 12,
      busyUnits: 18,
      plannedUnits: 18,
      recipeBatches: 18,
      productsPlanned: 1,
    },
    days: [{ date: "2026-08-29", typicalUnits: 12, plannedUnits: 18 }],
    series: [
      {
        date: "2026-08-28",
        actualUnits: 450,
        typicalUnits: 450,
        plannedUnits: 450,
      },
      {
        date: "2026-08-29",
        actualUnits: null,
        typicalUnits: 180,
        plannedUnits: 270,
      },
    ],
    backtest: {
      weeks: [
        {
          start: "2026-08-22",
          end: "2026-08-28",
          typicalUnits: 1200,
          busyUnits: 1800,
          actualUnits: 1100,
        },
      ],
      scoredWeeks: 1,
      errorPercent: 9.09,
      busyCoveredWeeks: 1,
    },
    products: [
      {
        productId: "22222222-2222-4222-8222-222222222222",
        productPublicId: "prd_loaf",
        productName: "Amaranth loaf",
        isActive: true,
        menuMember: true,
        weeksObserved: 7,
        typicalQuantity: 12,
        busyQuantity: 18,
        totalQuantity: 18,
        seasonalFactor: 1,
        days: [
          { date: "2026-08-29", typicalQuantity: 12, plannedQuantity: 18 },
        ],
        priceCents: 450,
        typicalCents: 5400,
        busyCents: 8100,
      },
    ],
    materialCost: { costCents: 1250, costedMaterials: 1, uncostedMaterials: 1 },
    recipeRequirements: [
      {
        recipeId: "recipe-1",
        recipePublicId: "rcp_loaf",
        recipeTitle: "Loaf",
        batches: 18,
        days: [{ date: "2026-08-29", batches: 18 }],
        yieldAmount: 1,
        yieldUnit: "each",
      },
    ],
    materialRequirements: [
      {
        ingredientId: "ingredient-1",
        ingredientPublicId: "ing_flour",
        ingredientName: "Flour",
        kind: "ingredient",
        usage: [{ quantity: 9000, unit: "g" }],
        purchase: [{ quantity: 9, unit: "kg" }],
        purchaseSize: 5,
        purchaseUnit: "kg",
        packs: 1.8,
        costCents: 1250,
        supplierPack: null,
      },
    ],
    unresolved: [],
  }

  it("reads both plans, the production series, and the backtest score", () => {
    const parsed = menuForecastPayloadSchema.parse(payload)

    expect(parsed.basis.plan).toBe("busy")
    expect(parsed.products[0]!.totalQuantity).toBe(18)
    expect(parsed.series[0]!.plannedUnits).toBe(450)
    expect(parsed.backtest.errorPercent).toBe(9.09)
    expect(parsed.products[0]!.typicalCents).toBe(5400)
    expect(parsed.materialCost.costCents).toBe(1250)
    expect(parsed.materialRequirements[0]!.packs).toBe(1.8)
    expect(parsed.recipeRequirements[0]!.yieldUnit).toBe("each")
  })

  it("rejects the four-week basis key", () => {
    expect(
      menuForecastPayloadSchema.safeParse({
        ...payload,
        basis: { ...payload.basis, matchingWeekdays: 4 },
      }).success
    ).toBe(false)
  })
})

describe("menu worksheet rows", () => {
  const menu = {
    id: "menu-1",
    publicId: "mnu_1",
    editVersion: 0,
    name: "Winter",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    createdAt: new Date("2026-03-01T00:00:00Z"),
    updatedAt: new Date("2026-03-01T00:00:00Z"),
  }
  const row = {
    id: "row-1",
    name: "Amaranth loaf",
    position: 0,
    sellPriceCents: 450,
    qtySold: 12,
    recipeId: null,
    recipePublicId: null,
    recipeName: null,
    productId: "22222222-2222-4222-8222-222222222222",
    productPublicId: "prd_loaf",
    productName: "Amaranth loaf",
    category: "Bread",
    foodCostCents: 120,
    sourceSellPriceCents: 450,
    sourceQtySold: 12,
    original: { sellPriceCents: 450, qtySold: 12, foodCostCents: 120 },
  }

  it("reads a product row and a recipe row through their links", () => {
    const payload = menuDetailPayloadSchema.parse({
      menu,
      items: [
        row,
        {
          ...row,
          id: "row-2",
          name: "Roasted tomato soup",
          position: 1,
          recipeId: "33333333-3333-4333-8333-333333333333",
          recipePublicId: "rcp_soup",
          recipeName: "Roasted tomato soup",
          productId: null,
          productPublicId: null,
          productName: null,
          foodCostCents: null,
          sourceSellPriceCents: null,
          sourceQtySold: null,
        },
      ],
      recipes: [],
      ingredients: [],
      products: [],
      currencyCode: "USD",
    })

    expect(payload.items[1]!.sourceQtySold).toBeNull()
  })

  it("refuses a row that still carries a composition", () => {
    expect(
      menuDetailPayloadSchema.safeParse({
        menu,
        items: [{ ...row, components: [] }],
        recipes: [],
        ingredients: [],
        products: [],
        currencyCode: "USD",
      }).success
    ).toBe(false)
  })
})

describe("ingredient summary schema", () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    publicId: "ing_box",
    userId: "22222222-2222-4222-8222-222222222222",
    name: "Takeout boxes",
    normalizedName: "takeout boxes",
    measureName: "each",
    purchaseCostCents: 4200,
    purchaseSize: 100,
    purchaseUnit: "each",
    priceSource: "user",
    categoryId: null,
    category: null,
    status: "active",
    nonEdible: true,
    tags: [],
    effectiveAllergenKeys: [],
    previousPrice: null,
    preferredSupplier: null,
    needsAttention: [],
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
  }

  it("reads the supply flag the pantry and supplies lists split on", () => {
    expect(ingredientSummarySchema.parse(row).nonEdible).toBe(true)
  })

  it("rejects a row without it", () => {
    const withoutKind = { ...row }
    delete (withoutKind as { nonEdible?: boolean }).nonEdible
    expect(ingredientSummarySchema.safeParse(withoutKind).success).toBe(false)
  })
})
