// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react"

const push = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push, replace: vi.fn() }),
  usePathname: () => "/products",
  useSearchParams: () => new URLSearchParams(),
}))
const saveSalesProduct = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock("@/app/(app)/products/actions", () => ({
  deleteMenuItem: vi.fn(),
  saveSalesProduct,
}))
vi.mock("@/app/(app)/menu/actions", () => ({ priceMenuComponent: vi.fn() }))
vi.mock("@/app/(app)/sales/actions", () => ({
  importSales: vi.fn(),
  matchSalesGroups: vi.fn(),
  undoSalesImport: vi.fn(),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ currencyCode: "USD", timezone: "UTC" }),
}))

const { ToastProvider } = await import("@/components/ui/toast")
const { ProductsTable } = await import("@/components/menu/products-table")

afterEach(() => {
  cleanup()
  push.mockClear()
  window.localStorage.clear()
})

type Row = Parameters<typeof ProductsTable>[0]["rows"][number]
type Variant = Row["variants"][number]

function productRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    publicId: "linzer",
    editVersion: 3,
    name: "Linzer",
    normalizedName: "linzer",
    sku: "LZ-1",
    skus: [{ id: "sku-1", sku: "LZ-1", quantityMultiplier: 1, position: 0 }],
    sellPriceCents: 450,
    baseUnit: "",
    category: "Pastry",
    isActive: true,
    costed: true,
    components: [],
    recipeLinks: [],
    variants: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as Row
}

function variant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: "v1",
    channel: "square",
    providerAccountId: "sq-1",
    matchKey: "square:item:LZ-1",
    sku: "LZ-1",
    externalName: "Linzer",
    externalVariantTitle: "",
    identityKind: "item",
    externalObjectId: "",
    productExternalObjectId: "",
    kind: "simple",
    quantityMultiplier: 1,
    attributionPercent: null,
    ...overrides,
  } as Variant
}

function productComponent(): Row["components"][number] {
  return {
    id: "cmp-1",
    recipeId: null,
    recipePublicId: null,
    recipeName: null,
    ingredientId: null,
    ingredientPublicId: null,
    ingredientName: null,
    productId: "other",
    productPublicId: "cannele",
    productName: "Cannelé",
    quantity: 3,
    unit: "",
    position: 0,
    nonEdible: false,
  }
}

const SORT_COLUMNS = {
  product: { asc: "name", desc: "-name" },
  sku: { asc: "sku", desc: "-sku" },
  category: { asc: "category", desc: "-category" },
  price: { asc: "price", desc: "-price" },
  updated: { asc: "updatedAt", desc: "-updatedAt" },
}

function renderTable({
  rows = [] as Row[],
  hasAnyProduct = rows.length > 0,
  posConnected = true,
  remote = false,
}: {
  rows?: Row[]
  hasAnyProduct?: boolean
  posConnected?: boolean
  remote?: boolean
} = {}) {
  return render(
    <ToastProvider>
      <ProductsTable
        rows={rows}
        hasAnyProduct={hasAnyProduct}
        status={null}
        posConnected={posConnected}
        remote={
          remote
            ? {
                searchValue: "",
                onSearchValueChange: vi.fn(),
                order: "-updatedAt",
                sortColumns: SORT_COLUMNS,
                onOrderChange: vi.fn(),
              }
            : undefined
        }
      />
    </ToastProvider>
  )
}

/** The desktop table; the mobile cards render the same rows alongside it. */
const table = () => within(document.querySelector("table") as HTMLElement)

const sortableHeaders = () =>
  Array.from(
    (document.querySelector("thead") as HTMLElement).querySelectorAll("button")
  )
    .map((button) => button.textContent?.trim())
    .filter(Boolean)

function openColumnsMenu() {
  fireEvent.click(screen.getAllByRole("button", { name: /^Columns/ })[0])
}

describe("the products empty states", () => {
  it("says where products come from and links to Connections with no POS", () => {
    renderTable({ posConnected: false })

    expect(document.body.textContent).toContain(
      "Products come from your Square or Shopify catalog"
    )
    expect(
      screen.getByRole("heading", { level: 2, name: "No products yet" })
    ).toBeDefined()
    expect(
      screen.getByRole("link", { name: "Connect a channel" })
    ).toHaveProperty("pathname", "/integrations/sales/connections")
  })

  it("keeps the plain empty row once a channel is connected", () => {
    renderTable()

    expect(document.body.textContent).toContain("No products yet")
  })

  it("distinguishes a filter that matched nothing from an empty catalog", () => {
    renderTable({ rows: [], hasAnyProduct: true })

    expect(document.body.textContent).toContain(
      "No products match that filter."
    )
  })
})

describe("the products toolbar", () => {
  it("sends Add product to the create page", () => {
    renderTable({ rows: [productRow()] })

    expect(
      screen.getByRole("link", { name: "Add product" }).getAttribute("href")
    ).toBe("/products/new")
  })

  it("offers the CSV export as the only item in Actions", async () => {
    renderTable({ rows: [productRow()] })

    fireEvent.click(screen.getByRole("button", { name: "Actions" }))

    expect(
      await screen.findByRole("menuitem", { name: "Export products" })
    ).toBeDefined()
    expect(screen.getAllByRole("menuitem")).toHaveLength(1)
  })
})

describe("the products columns", () => {
  it("links the name to the product and prints its canonical SKU alongside", () => {
    renderTable({ rows: [productRow()] })

    expect(table().getByRole("link", { name: "Linzer" })).toHaveProperty(
      "pathname",
      "/products/linzer"
    )
    expect(table().getByText("LZ-1")).toBeDefined()
  })

  it("lists the product's own and pack SKUs ahead of the variants'", () => {
    renderTable({
      rows: [
        productRow({
          skus: [
            { id: "s1", sku: "LZ-1", quantityMultiplier: 1, position: 0 },
            { id: "s2", sku: "LZ-6", quantityMultiplier: 6, position: 1 },
          ],
          variants: [variant(), variant({ id: "v2", sku: "LZ-POS" })],
        }),
      ],
    })

    // The Square LZ-1 folds into the product's own row.
    const trigger = table().getByRole("button", { name: "3 SKUs" })
    fireEvent.click(trigger)
    expect(screen.getByText("Pack SKU · ×6")).toBeDefined()
    expect(screen.getByText("LZ-POS")).toBeDefined()
  })

  it("dashes a product with no category", () => {
    renderTable({ rows: [productRow({ category: "" })] })

    expect(table().getAllByText("—").length).toBeGreaterThan(0)
  })

  it("counts the channels the product is sold on and lists them on demand", () => {
    renderTable({
      rows: [
        productRow({
          variants: [variant(), variant({ id: "v2", channel: "shopify" })],
        }),
      ],
    })

    const trigger = table().getByRole("button", { name: "2 sales channels" })
    expect(trigger.textContent).toBe("2")
    fireEvent.click(trigger)
    expect(screen.getByText("Square")).toBeDefined()
    expect(screen.getByText("Shopify")).toBeDefined()
  })

  it("counts this product's own variants and ignores modifier identities", () => {
    // Regression: a box is its own product now, so member variants never
    // reached this row's Variants count again.
    renderTable({
      rows: [
        productRow({
          variants: [
            variant(),
            variant({ id: "v2", channel: "shopify" }),
            variant({ id: "v3", identityKind: "modifier" }),
          ],
        }),
      ],
    })

    expect(
      table().getByRole("button", { name: "2 variants" }).textContent
    ).toBe("2")
  })

  it("badges a product whose composition holds another product", () => {
    renderTable({
      rows: [
        productRow({ components: [productComponent()] }),
        productRow({ id: "other", publicId: "cannele", name: "Cannelé" }),
      ],
    })

    expect(table().getAllByText("Bundle")).toHaveLength(1)
  })

  it("dashes a product with no variants", () => {
    renderTable({
      rows: [
        productRow({ variants: [variant()] }),
        productRow({ id: "other", publicId: "cannele", name: "Cannelé" }),
      ],
    })

    expect(table().getByRole("button", { name: "1 variant" })).toBeDefined()
    expect(table().getAllByText("—").length).toBeGreaterThan(0)
  })

  it("appends the unit a product is sold by, unless it is each", () => {
    renderTable({
      rows: [
        productRow({ sellPriceCents: 4500, baseUnit: "kg" }),
        productRow({ id: "other", publicId: "cannele", name: "Cannelé" }),
      ],
    })

    expect(table().getByText("$45.00 / kg")).toBeDefined()
    expect(table().getByText("$4.50")).toBeDefined()
  })

  it("dashes a price of zero", () => {
    renderTable({ rows: [productRow({ sellPriceCents: 0 })] })

    expect(table().getAllByText("—").length).toBeGreaterThan(0)
  })

  it("spells the row's status out as a badge", () => {
    renderTable({
      rows: [
        productRow(),
        productRow({
          id: "other",
          publicId: "cannele",
          name: "Cannelé",
          isActive: false,
        }),
      ],
    })

    expect(table().getByText("Active")).toBeDefined()
    expect(table().getByText("Inactive")).toBeDefined()
  })
})

describe("the hidden products columns", () => {
  it("leaves Updated out until the Columns menu reveals it", () => {
    renderTable({ rows: [productRow({ variants: [variant()] })] })

    expect(table().getByText("SKU")).toBeDefined()
    expect(table().queryByText("Updated")).toBeNull()

    openColumnsMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Updated" }))

    expect(table().getByText("Updated")).toBeDefined()
  })

  it("sorts on Product, Category, SKU and Price, and on Updated once revealed", () => {
    renderTable({ rows: [productRow()], remote: true })

    expect(sortableHeaders()).toEqual(["Product", "Category", "SKU", "Price"])

    openColumnsMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Updated" }))

    expect(sortableHeaders()).toEqual([
      "Product",
      "Category",
      "SKU",
      "Price",
      "Updated",
    ])
  })
})

describe("opening a product", () => {
  it("navigates when a row is clicked", async () => {
    renderTable({ rows: [productRow()] })

    fireEvent.click(table().getByText("Pastry"))

    // The click goes through the guard, which answers on the next tick.
    await waitFor(() => expect(push).toHaveBeenCalledWith("/products/linzer"))
  })

  it("archives a product from the row menu, and restores it", () => {
    renderTable({
      rows: [
        productRow(),
        productRow({
          id: "other",
          publicId: "cannele",
          name: "Cannelé",
          isActive: false,
        }),
      ],
    })

    fireEvent.click(
      screen.getAllByRole("button", { name: "Actions for Linzer" })[0]!
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive product" }))
    expect(saveSalesProduct).toHaveBeenCalledWith({
      id: "linzer",
      expectedEditVersion: expect.any(Number),
      isActive: false,
    })

    fireEvent.click(
      screen.getAllByRole("button", { name: "Actions for Cannelé" })[0]!
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore product" }))
    expect(saveSalesProduct).toHaveBeenCalledWith({
      id: "cannele",
      expectedEditVersion: expect.any(Number),
      isActive: true,
    })
  })

  it("navigates from the row menu rather than opening a dialog", async () => {
    renderTable({ rows: [productRow()] })

    fireEvent.click(
      screen.getAllByRole("button", { name: "Actions for Linzer" })[0]!
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit product" }))

    await waitFor(() => expect(push).toHaveBeenCalledWith("/products/linzer"))
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
