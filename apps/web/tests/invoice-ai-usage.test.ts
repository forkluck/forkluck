import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
const { action, system } = vi.hoisted(() => ({
  action: vi.fn(),
  system: vi.fn(),
}))
vi.mock("@/lib/backend/client", () => ({
  djangoAction: action,
  djangoSystemAction: system,
  BackendRequestError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string
    ) {
      super(message)
    }
  },
}))

import { BackendRequestError } from "@/lib/backend/client"
import { InvoiceAiBudgetError, invoiceAiBudget } from "@/lib/invoice-ai-usage"

beforeEach(() => {
  vi.resetAllMocks()
  action.mockResolvedValue({ readId: "read-1" })
  system.mockResolvedValue({ readId: "drive-read-1" })
})

describe("the invoice AI budget", () => {
  it("charges measured pages once and reserves every subsequent model attempt", async () => {
    const budget = invoiceAiBudget(3)
    await budget.beforeCall(2)
    await budget.beforeCall(2)
    expect(action.mock.calls).toEqual([
      [
        "invoice-ai-usage",
        { operation: "reserve", readId: null, pages: 3, attempts: 2 },
      ],
      [
        "invoice-ai-usage",
        { operation: "reserve", readId: "read-1", pages: 0, attempts: 2 },
      ],
    ])
  })

  it("records cumulative tokens across detection and extraction", async () => {
    const budget = invoiceAiBudget(2)
    await budget.beforeCall(2)
    await budget.record({ inputTokens: 100, outputTokens: 10 })
    await budget.record({ inputTokens: 200, outputTokens: 20 })
    expect(action).toHaveBeenLastCalledWith("invoice-ai-usage", {
      operation: "record",
      readId: "read-1",
      inputTokens: 300,
      outputTokens: 30,
    })
  })

  it("uses the system owner without touching browser sessions for Drive", async () => {
    const budget = invoiceAiBudget(4, "owner-1")
    await budget.beforeCall(2)
    await budget.record({ inputTokens: 50, outputTokens: 20 })
    expect(action).not.toHaveBeenCalled()
    expect(system).toHaveBeenNthCalledWith(
      1,
      "/internal/v1/system/invoice-ai-usage/",
      {
        operation: "reserve",
        userId: "owner-1",
        readId: null,
        pages: 4,
        attempts: 2,
      }
    )
    expect(system.mock.calls[1][1]).toMatchObject({
      operation: "record",
      userId: "owner-1",
      readId: "drive-read-1",
    })
  })

  it("stops on quota refusal and also when admission cannot be checked", async () => {
    action.mockRejectedValueOnce(
      new BackendRequestError(
        "Resets October 1",
        403,
        "invoice_ai_limit_reached"
      )
    )
    await expect(invoiceAiBudget(1).beforeCall(2)).rejects.toMatchObject({
      message: "Resets October 1",
      limitReached: true,
    })
    action.mockRejectedValueOnce(new Error("private backend details"))
    await expect(invoiceAiBudget(1).beforeCall(2)).rejects.toEqual(
      new InvoiceAiBudgetError(
        "Couldn't check your AI allowance. Please try again.",
        false
      )
    )
  })

  it("retains reserved work when telemetry fails without failing a completed scan", async () => {
    const budget = invoiceAiBudget(1)
    await budget.beforeCall(2)
    action.mockRejectedValueOnce(new Error("offline"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(budget.record({ inputTokens: 100 })).resolves.toBeUndefined()
    await budget.beforeCall(2)
    expect(action).toHaveBeenLastCalledWith("invoice-ai-usage", {
      operation: "reserve",
      readId: "read-1",
      pages: 0,
      attempts: 2,
    })
    warn.mockRestore()
  })

  it("does not meter a billing-exempt installation", async () => {
    action.mockResolvedValue({ readId: null })
    const budget = invoiceAiBudget(1)
    await budget.beforeCall(2)
    await budget.beforeCall(2)
    await budget.record({ inputTokens: 1 })
    expect(action).toHaveBeenCalledTimes(1)
  })
})
