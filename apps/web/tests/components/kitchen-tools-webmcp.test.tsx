// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"

const navigate = vi.hoisted(() => vi.fn())
const showAction = vi.hoisted(() => vi.fn())

vi.mock("@/components/primo/primo-provider", () => ({
  usePrimo: () => ({ navigate, showAction }),
}))
vi.mock("@/app/(app)/actions", () => ({
  runKitchenToolAction: vi.fn(),
}))

import { KitchenToolsWebMcp } from "@/components/primo/kitchen-tools-webmcp"
import { kitchenToolDescriptors } from "@/lib/primo/kitchen-tools"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  Reflect.deleteProperty(document, "modelContext")
})

describe("KitchenToolsWebMcp", () => {
  it("registers five strict read-only tools and aborts them on unmount", () => {
    const registrations: Array<{
      tool: Record<string, unknown>
      signal: AbortSignal
    }> = []
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn((tool, options) => {
          registrations.push({ tool, signal: options.signal })
          return Promise.resolve()
        }),
      },
    })

    const { unmount } = render(
      <KitchenToolsWebMcp tools={kitchenToolDescriptors()} />
    )
    expect(registrations.map(({ tool }) => tool.name)).toEqual([
      "find_recipes",
      "find_products",
      "get_product_sales",
      "show_recipe_batch",
      "get_recipe_cost_change",
    ])
    for (const { tool, signal } of registrations) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        untrustedContentHint: true,
      })
      expect(
        (tool.inputSchema as Record<string, unknown>).additionalProperties
      ).toBe(false)
      expect(signal.aborted).toBe(false)
    }
    unmount()
    expect(registrations.every(({ signal }) => signal.aborted)).toBe(true)
  })

  it("does nothing in an unsupported browser", () => {
    expect(() =>
      render(<KitchenToolsWebMcp tools={kitchenToolDescriptors()} />)
    ).not.toThrow()
  })

  it("isolates a rejected registration", async () => {
    const registerTool = vi
      .fn()
      .mockRejectedValueOnce(new Error("disabled"))
      .mockResolvedValue(undefined)
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool },
    })
    render(<KitchenToolsWebMcp tools={kitchenToolDescriptors()} />)
    await Promise.resolve()
    expect(registerTool).toHaveBeenCalledTimes(5)
  })
})
