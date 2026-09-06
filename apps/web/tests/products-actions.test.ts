import { beforeEach, describe, expect, it, vi } from "vitest"

const djangoAction = vi.hoisted(() => vi.fn())
const revalidatePath = vi.hoisted(() => vi.fn())

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath }))
vi.mock("@/lib/backend/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  djangoAction,
}))
vi.mock("@/lib/backend/queries", () => ({ getSalesIdentityLines: vi.fn() }))

const { recordManualSales, saveMenuItem, saveSalesProduct } =
  await import("@/app/(app)/products/actions")

beforeEach(() => {
  djangoAction.mockReset()
  revalidatePath.mockReset()
})

describe("saveSalesProduct", () => {
  it("forwards public identity, version, and scalar fields flat", async () => {
    djangoAction.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      publicId: "prd_000000000001",
      editVersion: 5,
    })

    await expect(
      saveSalesProduct({
        id: "prd_000000000001",
        expectedEditVersion: 4,
        name: "Maple Tart",
        sellPriceCents: 1200,
      })
    ).resolves.toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      publicId: "prd_000000000001",
      editVersion: 5,
    })

    expect(djangoAction).toHaveBeenCalledWith("save-sales-product", {
      id: "prd_000000000001",
      expectedEditVersion: 4,
      name: "Maple Tart",
      sellPriceCents: 1200,
    })
    expect(revalidatePath).toHaveBeenCalledWith("/products/prd_000000000001")
  })

  it("accepts legacy UUID product refs while rejecting empty patches", async () => {
    djangoAction.mockResolvedValue({
      id: "22222222-2222-2222-2222-222222222222",
      publicId: "prd_000000000001",
      editVersion: 5,
    })

    await expect(
      saveSalesProduct({
        id: "22222222-2222-4222-8222-222222222222",
        expectedEditVersion: 4,
        isActive: false,
      })
    ).resolves.toMatchObject({ editVersion: 5 })

    await expect(
      saveSalesProduct({
        id: "prd_000000000001",
        expectedEditVersion: 4,
      })
    ).resolves.toEqual({ error: "Choose a product field to save." })
  })

  it("accepts a full replacement component list without scalar or variant fields", async () => {
    djangoAction.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      publicId: "prd_000000000001",
      editVersion: 6,
    })
    const components = [
      {
        recipeId: "33333333-3333-4333-8333-333333333333",
        ingredientId: null,
        productId: null,
        quantity: 1,
        unit: "",
        position: 0,
      },
      {
        recipeId: null,
        ingredientId: "44444444-4444-4444-8444-444444444444",
        productId: null,
        quantity: 2.5,
        unit: "g",
        position: 1,
      },
    ]

    await saveSalesProduct({
      id: "prd_000000000001",
      expectedEditVersion: 5,
      components,
    })

    expect(djangoAction).toHaveBeenCalledWith("save-sales-product", {
      id: "prd_000000000001",
      expectedEditVersion: 5,
      components,
    })
  })

  it("rejects a component with neither or both targets before Django", async () => {
    const base = {
      id: "prd_000000000001",
      expectedEditVersion: 5,
      quantity: 1,
      unit: "",
      position: 0,
    }

    await expect(
      saveSalesProduct({
        ...base,
        components: [
          {
            recipeId: null,
            ingredientId: null,
            productId: null,
            quantity: base.quantity,
            unit: base.unit,
            position: base.position,
          },
        ],
      })
    ).resolves.toEqual({
      error: "A component needs exactly one recipe, product or ingredient.",
    })
    await expect(
      saveSalesProduct({
        ...base,
        components: [
          {
            recipeId: "33333333-3333-4333-8333-333333333333",
            ingredientId: "44444444-4444-4444-8444-444444444444",
            productId: null,
            quantity: base.quantity,
            unit: base.unit,
            position: base.position,
          },
        ],
      })
    ).resolves.toEqual({
      error: "A component needs exactly one recipe, product or ingredient.",
    })
    expect(djangoAction).not.toHaveBeenCalled()
  })
})

describe("saveMenuItem", () => {
  const boxVariant = {
    id: null,
    channel: "square" as const,
    providerAccountId: "M1",
    matchKey: "square:item:BOX",
    identityKind: "item" as const,
    sku: "BOX-6",
    externalName: "Box of 6",
    externalVariantTitle: "",
    externalObjectId: "BOX",
    productExternalObjectId: "",
    quantityMultiplier: 1,
    attributionPercent: 80,
  }

  it("creates a box as a product with components and a price", async () => {
    djangoAction.mockResolvedValue({ id: "product-box", claimedLines: 0 })
    const components = [
      {
        recipeId: null,
        ingredientId: null,
        productId: "33333333-3333-4333-8333-333333333333",
        quantity: 6,
        unit: "",
        position: 0,
      },
    ]

    await saveMenuItem({
      id: null,
      name: "Box of 6",
      isActive: true,
      recipeLinks: [],
      sellPriceCents: 2400,
      components,
      variants: [boxVariant],
    })

    expect(djangoAction).toHaveBeenCalledWith("save-sales-product", {
      id: null,
      name: "Box of 6",
      isActive: true,
      recipeLinks: [],
      sellPriceCents: 2400,
      components,
      variants: [boxVariant],
    })
  })

  it("requires a name now that a box types its own", async () => {
    await expect(
      saveMenuItem({
        id: null,
        name: "  ",
        isActive: true,
        recipeLinks: [],
        variants: [boxVariant],
      })
    ).resolves.toEqual({ error: "Enter a product name." })
    expect(djangoAction).not.toHaveBeenCalled()
  })
})

describe("recordManualSales", () => {
  it("forwards a flat manual sale payload and revalidates the product sales page", async () => {
    djangoAction.mockResolvedValue({
      ok: true,
      id: "manual-1",
      importId: "manual-import-1",
      productId: "22222222-2222-4222-8222-222222222222",
      publicId: "prd_000000000001",
      soldOn: "2026-08-27",
      deleted: false,
    })

    await expect(
      recordManualSales({
        productId: "prd_000000000001",
        soldOn: "2026-08-27",
        quantity: 3,
        totalNetCents: 2450,
      })
    ).resolves.toMatchObject({
      publicId: "prd_000000000001",
      soldOn: "2026-08-27",
      deleted: false,
    })

    expect(djangoAction).toHaveBeenCalledWith("record-manual-sales", {
      productId: "prd_000000000001",
      soldOn: "2026-08-27",
      quantity: 3,
      totalNetCents: 2450,
    })
    expect(revalidatePath).toHaveBeenCalledWith("/products/prd_000000000001")
  })

  it("accepts zero as deletion and omits the optional total", async () => {
    djangoAction.mockResolvedValue({
      ok: true,
      id: null,
      importId: "manual-import-1",
      productId: "22222222-2222-4222-8222-222222222222",
      publicId: "prd_000000000001",
      soldOn: "2026-08-27",
      deleted: true,
    })

    await recordManualSales({
      productId: "prd_000000000001",
      soldOn: "2026-08-27",
      quantity: 0,
    })

    expect(djangoAction).toHaveBeenCalledWith("record-manual-sales", {
      productId: "prd_000000000001",
      soldOn: "2026-08-27",
      quantity: 0,
    })
  })

  it("rejects negative quantities before Django", async () => {
    await expect(
      recordManualSales({
        productId: "prd_000000000001",
        soldOn: "2026-08-27",
        quantity: -1,
      })
    ).resolves.toEqual({ error: "Too small: expected number to be >=0" })
    expect(djangoAction).not.toHaveBeenCalled()
  })
})
