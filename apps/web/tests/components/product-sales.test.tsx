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

const recordManualSales = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())

vi.mock("@/app/(app)/products/actions", () => ({ recordManualSales }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

import { ProductSalesSection } from "@/components/menu/product-sales"
import type { ProductDetail } from "@/lib/backend/types"

const PRODUCT_ID = "22222222-2222-4222-8222-222222222222"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const PRODUCT: ProductDetail = {
  id: PRODUCT_ID,
  publicId: "prd_000000000001",
  editVersion: 8,
  name: "Maple Tart",
  normalizedName: "maple tart",
  sku: "TART-MAPLE",
  skus: [
    { id: "sku-1", sku: "TART-MAPLE", quantityMultiplier: 1, position: 0 },
  ],
  description: "",
  sellPriceCents: 1200,
  baseUnit: "",
  costIssues: [],
  category: "Pastry",
  isActive: true,
  costed: true,
  recipeLinks: [],
  variants: [],
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
        quantity: 2,
        grossCents: 2400,
        discountCents: 0,
        netSalesCents: 2400,
        taxCents: 0,
        refundCents: 0,
        currencyCode: "USD",
      },
      {
        id: "sale-shopify",
        soldOn: "2026-08-25",
        channel: "shopify",
        productId: PRODUCT_ID,
        productName: "Maple Tart",
        sku: "TART-MAPLE",
        itemName: "Maple Tart",
        quantity: 2,
        grossCents: 2400,
        discountCents: 0,
        netSalesCents: 2400,
        taxCents: 0,
        refundCents: 0,
        currencyCode: "USD",
      },
      {
        id: "manual-line-1",
        soldOn: "2026-08-24",
        channel: "manual",
        productId: PRODUCT_ID,
        productName: "Maple Tart",
        sku: "TART-MAPLE",
        itemName: "Maple Tart",
        quantity: 1,
        grossCents: 0,
        discountCents: 0,
        netSalesCents: null,
        taxCents: 0,
        refundCents: 0,
        currencyCode: "USD",
      },
    ],
    manualSales: [
      {
        id: "manual-line-1",
        soldOn: "2026-08-24",
        quantity: 1,
        totalNetCents: null,
      },
    ],
  },
  components: [],
  costCents: 300,
  marginCents: 900,
  marginPercent: 0.75,
  currencyCode: "USD",
  incompleteManualRevenue: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
}

/** A box: the including-bundles view left its money on its members. */
function sharedProduct(): ProductDetail {
  const asSold = {
    ...PRODUCT.sales,
    dailySales: [PRODUCT.sales.dailySales[0]],
  }
  return {
    ...PRODUCT,
    sales: {
      ...PRODUCT.sales,
      grossCents: 0,
      discountCents: 0,
      netSalesCents: 0,
      attributedNetSalesCents: 0,
      sharedToMembers: true,
      asSoldNetSalesCents: 4800,
      splitBasis: "count",
      dailySales: [],
    },
    salesAsSold: asSold,
  }
}

describe("Product sales", () => {
  it("switches the table between the two views", async () => {
    render(<ProductSalesSection product={sharedProduct()} />)

    expect(screen.getByText("No sales in this period.")).toBeDefined()
    fireEvent.click(
      screen.getByRole("button", { name: "View: Including bundles" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "As sold" }))

    expect(screen.getByText("Square")).toBeDefined()
  })

  it("renders daily channel rows and a count-only incomplete warning", () => {
    render(<ProductSalesSection product={PRODUCT} />)

    expect(screen.getByRole("heading", { name: "Sales" })).toBeDefined()
    expect(screen.getByText("Square")).toBeDefined()
    expect(screen.getByText("Shopify")).toBeDefined()
    expect(screen.getByText("Manual")).toBeDefined()
    expect(
      screen.getByText("1 manual sale is missing a total net amount.")
    ).toBeDefined()
    expect(screen.queryByText("$0.00")).toBeNull()
    expect(screen.getByText("4")).toBeDefined()
    expect(screen.getByText("$48.00")).toBeDefined()
  })

  it("shows the selected reporting period and initial ledger view", () => {
    render(
      <ProductSalesSection
        product={sharedProduct()}
        period={{ startDate: "2026-08-01", endDate: "2026-08-31" }}
        initialView="asSold"
      />
    )

    expect(screen.getByText("Aug 1 – 31, 2026")).toBeDefined()
    expect(screen.getByText("$48.00")).toBeDefined()
  })

  it("keeps the incomplete warning when the rows do not include manual entries", () => {
    const productWithoutManualRows: ProductDetail = {
      ...PRODUCT,
      sales: {
        ...PRODUCT.sales,
        dailySales: PRODUCT.sales.dailySales.filter(
          (row) => row.channel !== "manual"
        ),
        manualSales: [],
      },
    }
    render(<ProductSalesSection product={productWithoutManualRows} />)

    expect(
      screen.getByText(
        "Manual revenue details are incomplete; enter total net amounts to include them."
      )
    ).toBeDefined()
  })

  it("records a manual sale with an optional total converted to cents", async () => {
    recordManualSales.mockResolvedValue({
      ok: true,
      id: "manual-2",
      importId: "manual-import-1",
      productId: PRODUCT.id,
      publicId: PRODUCT.publicId,
      soldOn: "2026-08-27",
      deleted: false,
    })
    render(<ProductSalesSection product={PRODUCT} />)
    fireEvent.click(screen.getByRole("button", { name: "+ Record sale" }))

    fireEvent.change(screen.getByLabelText("Sold on"), {
      target: { value: "2026-08-27" },
    })
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity" }), {
      target: { value: "3" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: "Total net" }), {
      target: { value: "24.50" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Record sale" }))

    await waitFor(() => expect(recordManualSales).toHaveBeenCalledTimes(1))
    expect(recordManualSales).toHaveBeenCalledWith({
      productId: PRODUCT.publicId,
      soldOn: "2026-08-27",
      quantity: 3,
      totalNetCents: 2450,
    })
    expect(refresh).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("sends quantity zero without a nullable total when removing an entry", async () => {
    recordManualSales.mockResolvedValue({
      ok: true,
      id: null,
      importId: "manual-import-1",
      productId: PRODUCT.id,
      publicId: PRODUCT.publicId,
      soldOn: "2026-08-24",
      deleted: true,
    })
    render(<ProductSalesSection product={PRODUCT} />)
    fireEvent.click(screen.getByRole("button", { name: "+ Record sale" }))

    fireEvent.click(
      screen.getByRole("button", { name: "Remove manual sale 2026-08-24" })
    )
    await waitFor(() => expect(recordManualSales).toHaveBeenCalledTimes(1))
    expect(recordManualSales).toHaveBeenCalledWith({
      productId: PRODUCT.publicId,
      soldOn: "2026-08-24",
      quantity: 0,
    })
  })
})
