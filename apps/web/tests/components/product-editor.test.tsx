// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const saveSalesProduct = vi.hoisted(() => vi.fn())
const recordManualSales = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())

const untrackSalesVariant = vi.hoisted(() =>
  vi.fn(async (variantId: string) => ({ variantId }))
)
vi.mock("@/app/(app)/products/actions", () => ({
  saveSalesProduct,
  recordManualSales,
  untrackSalesVariant,
}))
vi.mock("@/app/(app)/menu/actions", () => ({ priceMenuComponent: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace }) }))
vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({
    go: async (href: string, options?: { replace?: boolean }) => {
      if (options?.replace) replace(href)
      return true
    },
    pending: false,
  }),
  GuardedLink: ({
    href,
    children,
    ...props
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useNavigationBlocker: () => ({ setIsBlocked: vi.fn() }),
}))

import { ProductEditor } from "@/components/menu/product-editor"
import type {
  MenuIngredientOption,
  MenuProductOption,
  MenuRecipeOption,
  ProductDetail,
} from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const PRODUCT_ID = "22222222-2222-2222-2222-222222222222"

const PRODUCT: ProductDetail = {
  id: PRODUCT_ID,
  publicId: "prd_000000000001",
  editVersion: 4,
  name: "Maple Tart",
  normalizedName: "maple tart",
  sku: "TART-MAPLE",
  skus: [
    { id: "sku-1", sku: "TART-MAPLE", quantityMultiplier: 1, position: 0 },
  ],
  description: "A small tart for the pastry case.",
  sellPriceCents: 1200,
  baseUnit: "",
  costIssues: [],
  category: "Pastry",
  isActive: true,
  costed: true,
  recipeLinks: [],
  variants: [
    {
      id: "variant-1",
      channel: "square",
      providerAccountId: "merchant-1",
      matchKey: "square:item:one",
      sku: "MAPLE-TART-POS",
      externalName: "Maple Tart",
      externalVariantTitle: "",
      identityKind: "item",
      externalObjectId: "one",
      productExternalObjectId: "",
      quantityMultiplier: 1,
      attributionPercent: null,
    },
  ],
  components: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      recipeId: "33333333-3333-4333-8333-333333333333",
      recipePublicId: "rcp_croissant",
      recipeName: "Croissant",
      ingredientId: null,
      ingredientPublicId: null,
      ingredientName: null,
      productId: null,
      productPublicId: null,
      productName: null,
      quantity: 1,
      unit: "",
      position: 0,
      nonEdible: false,
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      recipeId: null,
      recipePublicId: null,
      recipeName: null,
      ingredientId: "44444444-4444-4444-8444-444444444444",
      ingredientPublicId: "ing_flour",
      ingredientName: "Flour",
      productId: null,
      productPublicId: null,
      productName: null,
      quantity: 2,
      unit: "g",
      position: 1,
      nonEdible: false,
    },
    {
      id: "77777777-7777-4777-8777-777777777777",
      recipeId: null,
      recipePublicId: null,
      recipeName: null,
      ingredientId: "88888888-8888-4888-8888-888888888888",
      ingredientPublicId: "ing_box",
      ingredientName: "Pastry box",
      productId: null,
      productPublicId: null,
      productName: null,
      quantity: 1,
      unit: "each",
      position: 2,
      nonEdible: true,
    },
  ],
  sales: {
    lineCount: 3,
    quantity: 4,
    totalQuantity: 4,
    grossCents: 4800,
    discountCents: 0,
    netSalesCents: 4800,
    attributedNetSalesCents: 4800,
    taxCents: 0,
    refundCents: 0,
    sharedToMembers: false,
    asSoldNetSalesCents: 4800,
    splitBasis: null,
    dailySales: [
      {
        id: "sale-square",
        soldOn: "2026-08-26",
        channel: "square",
        productId: PRODUCT_ID,
        productName: "Maple Tart",
        sku: "TART-MAPLE",
        itemName: "Maple Tart",
        quantity: 4,
        grossCents: 4800,
        discountCents: 0,
        netSalesCents: 4800,
        taxCents: 0,
        refundCents: 0,
        currencyCode: "USD",
      },
    ],
    manualSales: [],
  },
  costCents: 300,
  marginCents: 900,
  marginPercent: 0.75,
  currencyCode: "USD",
  incompleteManualRevenue: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
}

const RECIPES: MenuRecipeOption[] = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    publicId: "rcp_croissant",
    title: "Croissant",
    kind: "recipe",
    category: "Pastry",
    menuPriceCents: null,
    ingredientCents: 300,
    suffix: "per batch",
    batchMeasures: [],
    servingAmount: null,
    servingUnit: null,
  },
]

const INGREDIENTS: MenuIngredientOption[] = [
  {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Flour",
    purchaseUnit: "g",
    nonEdible: false,
  },
]

const PRODUCTS: MenuProductOption[] = [
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    publicId: "prd_box",
    name: "Mooncake Box",
    componentProductIds: [],
  },
]

const SAVED = {
  id: PRODUCT.id,
  publicId: PRODUCT.publicId,
  editVersion: 5,
}

const COMPONENTS_PATCH = [
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
    quantity: 2,
    unit: "g",
    position: 1,
  },
  {
    recipeId: null,
    ingredientId: "88888888-8888-4888-8888-888888888888",
    productId: null,
    quantity: 1,
    unit: "each",
    position: 2,
  },
]

function renderEditor(product: ProductDetail | null = PRODUCT) {
  return render(
    <ProductEditor
      product={product}
      recipes={RECIPES}
      ingredients={INGREDIENTS}
      products={PRODUCTS}
      categories={[]}
    />
  )
}

function saveButton() {
  return screen.getByRole("button", { name: "Save" })
}

describe("Product editor", () => {
  it("renders every section of the product on one page", () => {
    renderEditor()

    expect(
      screen.getByRole("link", { name: "Products" }).getAttribute("href")
    ).toBe("/products")
    expect(document.getElementById("product-name")).not.toBeNull()
    expect(screen.getByRole("heading", { name: "Ingredients" })).toBeDefined()
    expect(screen.getByRole("heading", { name: "Supplies" })).toBeDefined()
    expect(screen.getByRole("heading", { name: "Variants" })).toBeDefined()
    expect(screen.getByText("MAPLE-TART-POS")).toBeDefined()
    expect(
      screen.getByText(/Manual revenue details are incomplete\./)
    ).toBeDefined()
    // One page, no tabs.
    expect(screen.queryByRole("link", { name: "Components" })).toBeNull()
    expect(screen.queryByRole("link", { name: "Sales" })).toBeNull()
  })

  it("badges a variant that sells this product in a multiple", () => {
    // Regression: the badge said Direct on every row, which named nothing.
    renderEditor({
      ...PRODUCT,
      variants: [{ ...PRODUCT.variants[0], quantityMultiplier: 12 }],
    })

    expect(screen.getByText("×12")).toBeDefined()
    expect(screen.queryByText("Direct")).toBeNull()
  })

  it("untracks a variant from its row menu after confirming", async () => {
    renderEditor()

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Maple Tart" })
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Untrack" }))
    fireEvent.click(screen.getByRole("button", { name: "Untrack variant" }))

    await waitFor(() =>
      expect(untrackSalesVariant).toHaveBeenCalledWith("variant-1")
    )
    // The action revalidates, so its answer is the refresh.
    expect(refresh).not.toHaveBeenCalled()
  })

  it("sends the scalars and the components in one patch", async () => {
    saveSalesProduct.mockResolvedValue(SAVED)
    renderEditor()

    fireEvent.change(screen.getByDisplayValue("Maple Tart"), {
      target: { value: "Updated Maple Tart" },
    })
    fireEvent.change(
      screen.getByRole("textbox", { name: "Quantity for Flour" }),
      {
        target: { value: "3" },
      }
    )
    fireEvent.click(saveButton())

    await waitFor(() => expect(saveSalesProduct).toHaveBeenCalledTimes(1))
    expect(saveSalesProduct).toHaveBeenCalledWith({
      id: "prd_000000000001",
      expectedEditVersion: 4,
      name: "Updated Maple Tart",
      skus: [{ sku: "TART-MAPLE", quantityMultiplier: 1 }],
      description: "A small tart for the pastry case.",
      category: "Pastry",
      sellPriceCents: 1200,
      baseUnit: "",
      isActive: true,
      components: [
        COMPONENTS_PATCH[0],
        { ...COMPONENTS_PATCH[1], quantity: 3 },
        COMPONENTS_PATCH[2],
      ],
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it("adds a second SKU with its units per sale", async () => {
    saveSalesProduct.mockResolvedValue(SAVED)
    renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "+ Add SKU" }))
    fireEvent.change(screen.getByRole("textbox", { name: "SKU 2" }), {
      target: { value: "TART-MAPLE-6" },
    })
    fireEvent.click(
      screen.getAllByRole("button", { name: "Units per sale" })[1]
    )
    fireEvent.change(
      await screen.findByRole("spinbutton", { name: "Units per sale" }),
      { target: { value: "6" } }
    )
    expect(screen.getAllByRole("button", { name: "Remove SKU" })).toHaveLength(
      2
    )
    fireEvent.click(saveButton())

    await waitFor(() => expect(saveSalesProduct).toHaveBeenCalledTimes(1))
    expect(saveSalesProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        skus: [
          { sku: "TART-MAPLE", quantityMultiplier: 1 },
          { sku: "TART-MAPLE-6", quantityMultiplier: 6 },
        ],
      })
    )
  })

  it("refuses a SKU repeating another, or left blank", async () => {
    renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "+ Add SKU" }))
    fireEvent.change(screen.getByRole("textbox", { name: "SKU 2" }), {
      target: { value: "tart-maple" },
    })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(screen.getByText("SKUs have to be different.")).toBeDefined()
    )
    fireEvent.change(screen.getByRole("textbox", { name: "SKU 2" }), {
      target: { value: " " },
    })
    fireEvent.click(saveButton())

    await waitFor(() => expect(screen.getByText("Enter a SKU.")).toBeDefined())
    expect(saveSalesProduct).not.toHaveBeenCalled()
  })

  it("shows only the add button when the product has no SKU", () => {
    renderEditor({ ...PRODUCT, sku: "", skus: [] })

    expect(screen.queryByRole("textbox", { name: "SKU" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Remove SKU" })).toBeNull()
    expect(screen.getByRole("button", { name: "+ Add SKU" })).toBeDefined()
  })

  it("clears every SKU when the only row is removed", async () => {
    saveSalesProduct.mockResolvedValue(SAVED)
    renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "Remove SKU" }))
    fireEvent.click(saveButton())

    await waitFor(() => expect(saveSalesProduct).toHaveBeenCalledTimes(1))
    expect(saveSalesProduct).toHaveBeenCalledWith(
      expect.objectContaining({ skus: [] })
    )
  })

  it("spends no version when nothing was touched", async () => {
    renderEditor()

    fireEvent.click(saveButton())

    await waitFor(() => expect(refresh).not.toHaveBeenCalled())
    expect(saveSalesProduct).not.toHaveBeenCalled()
  })

  it("focuses the name when it is empty", async () => {
    renderEditor()

    fireEvent.change(screen.getByDisplayValue("Maple Tart"), {
      target: { value: "" },
    })
    fireEvent.click(saveButton())

    await waitFor(() => expect(document.activeElement?.id).toBe("product-name"))
    expect(saveSalesProduct).not.toHaveBeenCalled()
  })

  it("focuses the price when it does not read as money", async () => {
    renderEditor()

    fireEvent.change(screen.getByDisplayValue("12.00"), {
      target: { value: "abc" },
    })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(document.activeElement?.id).toBe("product-price")
    )
    expect(saveSalesProduct).not.toHaveBeenCalled()
  })

  it("focuses the component row whose quantity is wrong", async () => {
    renderEditor()

    fireEvent.change(screen.getByLabelText("Quantity for Flour"), {
      target: { value: "" },
    })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(
        screen.getByText("Each component needs a positive quantity.")
      ).toBeDefined()
    )
    expect(document.activeElement?.id).toBe(
      "component-quantity-66666666-6666-4666-8666-666666666666"
    )
    expect(saveSalesProduct).not.toHaveBeenCalled()
  })

  it("renames the breadcrumb as the name field is typed in", () => {
    renderEditor()

    fireEvent.change(screen.getByDisplayValue("Maple Tart"), {
      target: { value: "Cherry Tart" },
    })

    expect(screen.getByText("Cherry Tart")).toBeDefined()
  })

  it("says why a product has no cost instead of blaming a missing recipe", () => {
    renderEditor({
      ...PRODUCT,
      costCents: null,
      marginCents: null,
      marginPercent: null,
      costIssues: [
        {
          code: "missing-ingredient-price",
          path: ["Tart shell", "Butter"],
          detail: null,
        },
      ],
    })

    expect(screen.getByText("Not accounted for")).toBeDefined()
    expect(screen.getByText("Tart shell · Butter — No price yet")).toBeDefined()
    // The old copy named the one cause it could not distinguish.
    expect(screen.queryByText(/Add a recipe to cost this product/)).toBeNull()
  })

  it("lists every reason the product cannot be costed", () => {
    renderEditor({
      ...PRODUCT,
      costCents: null,
      marginCents: null,
      marginPercent: null,
      costIssues: [
        { code: "missing-ingredient-price", path: ["Butter"], detail: null },
        { code: "unresolved-conversion", path: ["Flour"], detail: null },
      ],
    })

    expect(screen.getByText("Butter — No price yet")).toBeDefined()
    expect(
      screen.getByText("Flour — Not a measurement of this ingredient")
    ).toBeDefined()
  })

  it("shows no cost alert while the composition resolves", () => {
    renderEditor()

    expect(screen.queryByText("Not accounted for")).toBeNull()
  })

  it("reads the price in the unit the product is sold by", () => {
    renderEditor({ ...PRODUCT, baseUnit: "g" })

    expect(screen.getByText("Price (USD)")).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Sold by unit" }).textContent
    ).toContain("g")
  })

  it("sends the chosen unit, and blank for each", async () => {
    saveSalesProduct.mockResolvedValue(SAVED)
    renderEditor({ ...PRODUCT, baseUnit: "g" })

    fireEvent.change(screen.getByDisplayValue("Maple Tart"), {
      target: { value: "Maple Tart by weight" },
    })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(saveSalesProduct).toHaveBeenCalledWith(
        expect.objectContaining({ baseUnit: "g" })
      )
    )
  })

  it("never resets a stored unit this bundle does not recognize", async () => {
    saveSalesProduct.mockResolvedValue(SAVED)
    // A slug added to the vocabulary after this bundle was built.
    renderEditor({ ...PRODUCT, baseUnit: "pint" })

    fireEvent.change(screen.getByDisplayValue("Maple Tart"), {
      target: { value: "Renamed Tart" },
    })
    fireEvent.click(saveButton())

    await waitFor(() => expect(saveSalesProduct).toHaveBeenCalled())
    expect("baseUnit" in saveSalesProduct.mock.calls[0][0]).toBe(false)
  })

  it("records a manual sale from the sales section", async () => {
    recordManualSales.mockResolvedValue({
      ok: true,
      id: "manual-2",
      importId: "manual-import-1",
      productId: PRODUCT.id,
      publicId: PRODUCT.publicId,
      soldOn: "2026-08-27",
      deleted: false,
    })
    renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "+ Record sale" }))

    fireEvent.change(screen.getByLabelText("Sold on"), {
      target: { value: "2026-08-27" },
    })
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity" }), {
      target: { value: "3" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Record sale" }))

    await waitFor(() => expect(recordManualSales).toHaveBeenCalledTimes(1))
    expect(recordManualSales).toHaveBeenCalledWith({
      productId: PRODUCT.publicId,
      soldOn: "2026-08-27",
      quantity: 3,
    })
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("a product that does not exist yet", () => {
  it("opens on an empty draft with nothing the product has not earned", () => {
    renderEditor(null)

    expect(screen.getByText("New product")).toBeDefined()
    expect(
      (document.getElementById("product-name") as HTMLInputElement).value
    ).toBe("")
    expect(
      (document.getElementById("product-price") as HTMLInputElement).value
    ).toBe("0.00")
    // The name takes the cursor, and the rail leads with Category: a product
    // that does not exist yet is created Active, so Status is not asked.
    expect(document.activeElement?.id).toBe("product-name")
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull()
    // Variants, economics and sales all read a product the server has not
    // seen, so the create page carries none of them.
    expect(screen.queryByRole("heading", { name: "Variants" })).toBeNull()
    expect(screen.queryByText("Margin")).toBeNull()
    expect(screen.queryByRole("button", { name: "+ Record sale" })).toBeNull()
    // The composition picker is here from the start.
    expect(screen.getByRole("heading", { name: "Ingredients" })).toBeDefined()
  })

  it("creates the product and hands over its own page", async () => {
    saveSalesProduct.mockResolvedValue({
      id: PRODUCT_ID,
      publicId: "prd_000000000007",
      editVersion: 0,
    })
    renderEditor(null)

    fireEvent.change(document.getElementById("product-name")!, {
      target: { value: "Linzer Cookie" },
    })
    fireEvent.click(saveButton())

    await waitFor(() => expect(saveSalesProduct).toHaveBeenCalledTimes(1))
    expect(saveSalesProduct).toHaveBeenCalledWith({
      id: null,
      name: "Linzer Cookie",
      skus: [],
      description: "",
      category: "",
      sellPriceCents: 0,
      baseUnit: "",
      isActive: true,
      components: [],
    })
    // A create guards no version, and the page it lands on does its own read.
    expect("expectedEditVersion" in saveSalesProduct.mock.calls[0][0]).toBe(
      false
    )
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/products/prd_000000000007")
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  it("refuses to create a product with no name", async () => {
    renderEditor(null)

    fireEvent.click(saveButton())

    await waitFor(() => expect(document.activeElement?.id).toBe("product-name"))
    expect(saveSalesProduct).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})
