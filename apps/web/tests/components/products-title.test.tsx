// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

const pathname = vi.hoisted(() => ({ value: "/products" }))

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.value,
}))
import { ProductsTitle } from "@/components/menu/products-title"

afterEach(() => {
  cleanup()
  pathname.value = "/products"
})

describe("ProductsTitle", () => {
  it.each([
    "/products/prd_000000000001",
    "/products/22222222-2222-2222-2222-222222222222",
    // The create page draws the same editor chrome before it has an id.
    "/products/new",
  ])("leaves detail-page chrome to the page (%s)", (detailPath) => {
    pathname.value = detailPath
    render(<ProductsTitle />)

    expect(screen.queryByText("Products")).toBeNull()
  })

  it("names the hub without a breadcrumb", () => {
    render(<ProductsTitle />)

    expect(screen.getByText("Products")).toBeDefined()
    expect(screen.queryByRole("link")).toBeNull()
  })
})
