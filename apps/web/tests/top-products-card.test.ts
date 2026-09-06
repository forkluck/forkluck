import { describe, expect, it } from "vitest"

import type { SalesOverview } from "../lib/backend/types"
import { topProducts } from "../lib/top-products"

const productSales: SalesOverview["topProducts"] = [
  {
    productId: "cookie",
    productName: "Cookie",
    channel: "square",
    quantity: 2,
    netSalesCents: 600,
    sharedToMembers: false,
  },
  {
    productId: "cookie",
    productName: "Cookie",
    channel: "shopify",
    quantity: 12,
    netSalesCents: 2_400,
    sharedToMembers: false,
  },
  {
    productId: "cake",
    productName: "Cake",
    channel: "square",
    quantity: 1,
    netSalesCents: 1_000,
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

describe("top products", () => {
  it("combines provider aggregates when all channels are selected", () => {
    expect(topProducts(productSales, "all")).toEqual([
      {
        id: "cookie",
        name: "Cookie",
        quantity: 14,
        netSalesCents: 3_000,
        sharedToMembers: false,
      },
      {
        id: "cake",
        name: "Cake",
        quantity: 1,
        netSalesCents: 1_000,
        sharedToMembers: false,
      },
      // Regression: a box keeps its units and sorts under the products its
      // money was counted on.
      {
        id: "box",
        name: "Sampler box",
        quantity: 4,
        netSalesCents: 0,
        sharedToMembers: true,
      },
    ])
  })

  it("ranks only the selected provider", () => {
    expect(topProducts(productSales, "square")).toEqual([
      {
        id: "cake",
        name: "Cake",
        quantity: 1,
        netSalesCents: 1_000,
        sharedToMembers: false,
      },
      {
        id: "cookie",
        name: "Cookie",
        quantity: 2,
        netSalesCents: 600,
        sharedToMembers: false,
      },
    ])
    expect(topProducts(productSales, "shopify").map((row) => row.id)).toEqual([
      "cookie",
      "box",
    ])
  })
})
