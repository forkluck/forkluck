// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  go: vi.fn(),
  run: vi.fn(),
  toast: { add: vi.fn(), update: vi.fn(), close: vi.fn() },
}))

vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({ go: mocks.go }),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => mocks.toast,
}))
vi.mock("@/app/(app)/actions", () => ({
  runKitchenToolAction: mocks.run,
}))

import { KitchenToolsWebMcp } from "@/components/kitchen-tools-webmcp"
import { kitchenToolDescriptors } from "@/lib/kitchen-tools/catalog"

beforeEach(() => {
  mocks.go.mockResolvedValue(true)
  mocks.toast.add.mockReturnValue("read-toast")
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  Reflect.deleteProperty(document, "modelContext")
})

describe("KitchenToolsWebMcp", () => {
  function register() {
    const tools: Parameters<
      NonNullable<Document["modelContext"]>["registerTool"]
    >[0][] = []
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn((tool) => {
          tools.push(tool)
          return Promise.resolve()
        }),
      },
    })
    render(<KitchenToolsWebMcp tools={kitchenToolDescriptors()} />)
    return tools
  }

  it("reads and reports success without a Primo provider", async () => {
    const tools = register()
    const result = { ok: true, tool: "find_recipes", recipes: [] }
    mocks.run.mockResolvedValue(result)
    expect(
      await tools[0].execute(
        { query: "soup" },
        { signal: new AbortController().signal }
      )
    ).toBe(result)
    expect(mocks.run).toHaveBeenCalledWith("find_recipes", { query: "soup" })
    expect(mocks.toast.add).toHaveBeenCalledWith({
      title: "Finding recipes…",
      timeout: 0,
    })
    expect(mocks.toast.update).toHaveBeenCalledWith("read-toast", {
      title: "Kitchen read complete",
      type: "success",
      timeout: 5000,
    })
    expect(mocks.go).not.toHaveBeenCalled()
  })

  it("reports a failed read without navigating", async () => {
    const tools = register()
    mocks.run.mockResolvedValue({ ok: false, message: "Nothing found." })
    await tools[0].execute({}, { signal: new AbortController().signal })
    expect(mocks.toast.update).toHaveBeenCalledWith("read-toast", {
      title: "Nothing found.",
      type: "error",
      timeout: 5000,
    })
    expect(mocks.go).not.toHaveBeenCalled()
  })

  it("honors the unsaved-change navigation guard and closes cancelled feedback", async () => {
    const tools = register()
    mocks.run.mockResolvedValue({ ok: true, view: "/recipes/rcp_0123456789ab" })
    mocks.go.mockResolvedValue(false)
    await expect(
      tools[3].execute({}, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(mocks.go).toHaveBeenCalledWith("/recipes/rcp_0123456789ab")
    expect(mocks.toast.close).toHaveBeenCalledWith("read-toast")
    expect(mocks.toast.update).not.toHaveBeenCalled()
  })

  it("returns an acting result only after the route transition, capped at three seconds", async () => {
    vi.useFakeTimers()
    try {
      const tools = register()
      const result = { ok: true, view: "/recipes/rcp_0123456789ab" }
      mocks.run.mockResolvedValue(result)
      let settled = false
      const execution = tools[3]
        .execute({}, { signal: new AbortController().signal })
        .then((value) => {
          settled = true
          return value
        })
      await vi.advanceTimersByTimeAsync(2_900)
      expect(mocks.go).toHaveBeenCalledWith("/recipes/rcp_0123456789ab")
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      expect(await execution).toBe(result)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a rejected server action and clears its permanent progress toast", async () => {
    const tools = register()
    mocks.run.mockRejectedValue(new Error("Offline"))
    await expect(
      tools[0].execute({}, { signal: new AbortController().signal })
    ).rejects.toThrow("Offline")
    expect(mocks.toast.update).toHaveBeenCalledWith("read-toast", {
      title: "Couldn't complete that kitchen read.",
      type: "error",
      timeout: 5000,
    })
  })

  it("discards an in-flight result when the signed-in shell unmounts", async () => {
    const tools = register()
    const answer = Promise.withResolvers<unknown>()
    mocks.run.mockReturnValue(answer.promise)
    const signal = new AbortController().signal
    const execution = tools[3].execute({}, { signal })
    cleanup()
    answer.resolve({ ok: true, view: "/recipes/rcp_0123456789ab" })
    await expect(execution).rejects.toMatchObject({ name: "AbortError" })
    expect(signal.aborted).toBe(false)
    expect(mocks.go).not.toHaveBeenCalled()
    expect(mocks.toast.close).toHaveBeenCalledWith("read-toast")
  })

  it("registers eight strict read-only tools and aborts them on unmount", () => {
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
      "calculate_batch_cost",
      "get_top_products",
      "get_ingredient_price_changes",
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
    expect(registerTool).toHaveBeenCalledTimes(8)
  })
})
