import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getProductDetail: vi.fn(),
  getMenuSources: vi.fn(),
  getProductCategories: vi.fn(),
  getBusinessSettings: vi.fn(),
}))

vi.mock("@/lib/auth-session", () => ({ requireUser: vi.fn() }))
vi.mock("@/lib/backend/queries", () => mocks)
vi.mock("next/navigation", () => ({ notFound: vi.fn() }))
vi.mock("@/components/menu/product-editor", () => ({
  ProductEditor: ({
    salesPeriod,
    salesView,
  }: {
    salesPeriod: { startDate: string; endDate: string }
    salesView: string
  }) => (
    <div>{`${salesPeriod.startDate}|${salesPeriod.endDate}|${salesView}`}</div>
  ),
}))

import ProductPage from "@/app/(app)/products/[productId]/page"

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-09-03T12:00:00Z"))
  mocks.getBusinessSettings.mockResolvedValue({ timezone: "UTC" })
  mocks.getProductDetail.mockResolvedValue({ publicId: "prd_0123456789ab" })
  mocks.getMenuSources.mockResolvedValue({
    recipes: [],
    ingredients: [],
    products: [],
  })
  mocks.getProductCategories.mockResolvedValue([])
})

afterEach(() => vi.useRealTimers())

describe("product page sales window", () => {
  it("passes an explicit range and as-sold view to the read and page", async () => {
    const page = await ProductPage({
      params: Promise.resolve({ productId: "prd_0123456789ab" }),
      searchParams: Promise.resolve({
        start: "2026-08-01",
        end: "2026-08-31",
        view: "as_sold",
      }),
    })
    expect(mocks.getProductDetail).toHaveBeenCalledWith(
      "prd_0123456789ab",
      "2026-08-01",
      "2026-08-31"
    )
    expect(renderToStaticMarkup(page)).toContain("2026-08-01|2026-08-31|asSold")
  })

  it("uses one day when start is valid and end is absent", async () => {
    await ProductPage({
      params: Promise.resolve({ productId: "prd_0123456789ab" }),
      searchParams: Promise.resolve({ start: "2026-08-14" }),
    })
    expect(mocks.getProductDetail).toHaveBeenCalledWith(
      "prd_0123456789ab",
      "2026-08-14",
      "2026-08-14"
    )
  })

  it("falls back to the last 30 complete days for absent or bad dates", async () => {
    for (const searchParams of [
      {},
      { start: "bad" },
      { start: "2026-08-01", end: "bad" },
    ]) {
      mocks.getProductDetail.mockClear()
      await ProductPage({
        params: Promise.resolve({ productId: "prd_0123456789ab" }),
        searchParams: Promise.resolve(searchParams),
      })
      expect(mocks.getProductDetail).toHaveBeenCalledWith(
        "prd_0123456789ab",
        "2026-08-04",
        "2026-09-02"
      )
    }
  })
})
