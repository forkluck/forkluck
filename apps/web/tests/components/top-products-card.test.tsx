// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { TopProductsCard } from "@/components/overview/top-products-card"
import type { SalesOverview } from "@/lib/backend/types"

afterEach(cleanup)

const ROWS: SalesOverview["topProducts"] = [
  {
    productId: "cookie",
    productName: "Cookie",
    channel: "shopify",
    quantity: 12,
    netSalesCents: 2_400,
    sharedToMembers: false,
  },
  {
    productId: "box",
    productName: "Sampler box",
    channel: "shopify",
    quantity: 4,
    netSalesCents: 0,
    sharedToMembers: true,
  },
]

describe("top products card", () => {
  it("says a bundle's money is counted on the products inside it", () => {
    // Regression: a box would otherwise read as $0 beside its real units.
    render(
      <TopProductsCard productSales={ROWS} channel="all" currencyCode="USD" />
    )

    expect(screen.getByText("Shared").getAttribute("title")).toBe(
      "Counted on the products inside this bundle"
    )
    expect(screen.getByText("4")).toBeDefined()
    expect(
      screen.getByText("Bundle sales are counted on the products inside them.")
    ).toBeDefined()
  })

  it("leaves the footnote out when no bundle is on the list", () => {
    render(
      <TopProductsCard
        productSales={[ROWS[0]]}
        channel="all"
        currencyCode="USD"
      />
    )

    expect(screen.queryByText("Shared")).toBeNull()
    expect(
      screen.queryByText(
        "Bundle sales are counted on the products inside them."
      )
    ).toBeNull()
  })
})
