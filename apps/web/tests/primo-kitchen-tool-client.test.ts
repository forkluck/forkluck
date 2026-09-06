import { describe, expect, it, vi } from "vitest"

import { executeKitchenTool } from "@/lib/primo/kitchen-tool-client"
import type { KitchenToolResult } from "@/lib/primo/kitchen-tool-results"

const result = {
  ok: false,
  tool: "find_recipes",
  reason: "not_found",
  message: "Nothing found.",
} satisfies KitchenToolResult

describe("executeKitchenTool", () => {
  it("shows progress, runs, navigates, and returns the same object", async () => {
    const calls: string[] = []
    const value = {
      ok: true,
      tool: "get_product_sales",
      product: {
        productRef: "prd_0123456789ab",
        name: "Mooncake",
        baseUnit: "each",
      },
      period: {
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        label: "August",
      },
      units: 1,
      netSalesCents: 200,
      currencyCode: "USD",
      salesView: "as_sold",
      incompleteRevenue: false,
      view: "/products/prd_0123456789ab",
    } satisfies KitchenToolResult
    const output = await executeKitchenTool(
      "get_product_sales",
      {},
      {
        showAction: () => calls.push("show"),
        run: async () => {
          calls.push("run")
          return value
        },
        navigate: async () => {
          calls.push("navigate")
        },
      },
      new AbortController().signal
    )
    expect(calls).toEqual(["show", "run", "navigate"])
    expect(output).toBe(value)
  })

  it("does not navigate a result without a view", async () => {
    const navigate = vi.fn()
    await executeKitchenTool(
      "find_recipes",
      {},
      { showAction: vi.fn(), run: vi.fn().mockResolvedValue(result), navigate },
      new AbortController().signal
    )
    expect(navigate).not.toHaveBeenCalled()
  })

  it("stops before the run or between the run and navigation", async () => {
    const before = new AbortController()
    before.abort()
    const run = vi.fn().mockResolvedValue(result)
    await expect(
      executeKitchenTool(
        "find_recipes",
        {},
        { showAction: vi.fn(), run, navigate: vi.fn() },
        before.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(run).not.toHaveBeenCalled()

    const between = new AbortController()
    const navigate = vi.fn()
    await expect(
      executeKitchenTool(
        "find_recipes",
        {},
        {
          showAction: vi.fn(),
          run: vi.fn().mockImplementation(async () => {
            between.abort()
            return result
          }),
          navigate,
        },
        between.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(navigate).not.toHaveBeenCalled()
  })
})
