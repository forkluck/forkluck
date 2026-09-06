// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const saveIgnoreRule = vi.fn()
const previewIgnoreRule = vi.fn()

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/products/actions", () => ({
  saveIgnoreRule: (...args: unknown[]) => saveIgnoreRule(...args),
  previewIgnoreRule: (...args: unknown[]) => previewIgnoreRule(...args),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/integrations/sales/mapping/rules",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))

import { Button } from "@/components/ui/button"
import type { SalesIgnoreRuleRow } from "@/lib/backend/types"
import { IgnoreRuleDialog } from "@/components/menu/ignore-rule-dialog"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function open(rule?: SalesIgnoreRuleRow) {
  previewIgnoreRule.mockResolvedValue({
    items: [],
    meta: {
      pagination: {
        page: 1,
        limit: 25,
        pages: 1,
        total: 0,
        next: null,
        prev: null,
      },
    },
    truncated: false,
  })
  render(<IgnoreRuleDialog rule={rule} trigger={<Button>New rule</Button>} />)
  fireEvent.click(screen.getByRole("button", { name: "New rule" }))
}

describe("IgnoreRuleDialog", () => {
  it("starts with one condition and cannot save it blank", () => {
    open()
    expect(screen.getAllByLabelText("Condition value")).toHaveLength(1)
    expect(
      screen.getByRole("button", { name: "Save rule" }).hasAttribute("disabled")
    ).toBe(false)
  })

  it("saving becomes possible once a condition has a value", () => {
    open()
    fireEvent.change(screen.getByLabelText("Condition value"), {
      target: { value: "GC-" },
    })
    expect(
      screen.getByRole("button", { name: "Save rule" }).hasAttribute("disabled")
    ).toBe(false)
  })

  it("adds conditions up to the five the backend accepts", () => {
    open()
    for (let index = 1; index < 5; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: /Add condition/ }))
    }
    expect(screen.getAllByLabelText("Condition value")).toHaveLength(5)
    expect(screen.queryByRole("button", { name: /Add condition/ })).toBeNull()
  })

  it("keeps the only condition undeletable", () => {
    open()
    expect(
      screen
        .getByRole("button", { name: "Remove condition" })
        .hasAttribute("disabled")
    ).toBe(true)
  })

  it("sends only complete conditions to the preview", async () => {
    open()
    fireEvent.change(screen.getByLabelText("Condition value"), {
      target: { value: "GC-" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Add condition/ }))

    await waitFor(() => {
      expect(previewIgnoreRule).toHaveBeenCalled()
    })
    const [call] = previewIgnoreRule.mock.calls.at(-1) as [
      { conditions: unknown[] },
    ]
    expect(call.conditions).toHaveLength(1)
  })

  it("saves the channel and conditions as written", async () => {
    saveIgnoreRule.mockResolvedValue({ rule: {}, ignored: 2 })
    open()
    fireEvent.click(screen.getByRole("button", { name: "Shopify" }))
    fireEvent.change(screen.getByLabelText("Condition value"), {
      target: { value: "GC-" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }))

    await waitFor(() => {
      expect(saveIgnoreRule).toHaveBeenCalledWith({
        id: undefined,
        channel: "shopify",
        enabled: true,
        conditions: [{ field: "sku", operator: "is", value: "GC-" }],
      })
    })
  })

  it("stays open and says why when the save did not land", async () => {
    saveIgnoreRule.mockResolvedValue({ error: "Backend is down" })
    open()
    fireEvent.change(screen.getByLabelText("Condition value"), {
      target: { value: "GC-" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }))

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Backend is down")
    )
    expect(screen.getByRole("button", { name: "Save rule" })).toBeTruthy()
  })

  it("saves no channel at all when the rule covers every one", async () => {
    saveIgnoreRule.mockResolvedValue({ rule: {}, ignored: 2 })
    open()
    fireEvent.click(screen.getByRole("button", { name: "All channels" }))
    fireEvent.change(screen.getByLabelText("Condition value"), {
      target: { value: "GC-" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }))

    await waitFor(() => {
      expect(saveIgnoreRule).toHaveBeenCalledWith({
        id: undefined,
        channel: null,
        enabled: true,
        conditions: [{ field: "sku", operator: "is", value: "GC-" }],
      })
    })
  })

  it("reopens an every-channel rule on every channel", async () => {
    // A default would read the absent channel as Square and quietly narrow a
    // rule the merchant only came here to rename.
    saveIgnoreRule.mockResolvedValue({ rule: {}, ignored: 0 })
    open({
      id: "11111111-1111-4111-8111-111111111111",
      channel: null,
      enabled: true,
      conditions: [{ field: "sku", operator: "is", value: "GC-" }],
      ignoredCount: 1,
      createdAt: new Date("2026-08-01T00:00:00Z"),
      updatedAt: new Date("2026-08-01T00:00:00Z"),
    })
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }))

    await waitFor(() => {
      expect(saveIgnoreRule).toHaveBeenCalledWith(
        expect.objectContaining({ channel: null })
      )
    })
  })

  it("closes an untouched rule without asking", async () => {
    open({
      id: "11111111-1111-4111-8111-111111111111",
      channel: "square",
      enabled: true,
      conditions: [{ field: "sku", operator: "is", value: "GC-" }],
      ignoredCount: 1,
      createdAt: new Date("2026-08-01T00:00:00Z"),
      updatedAt: new Date("2026-08-01T00:00:00Z"),
    })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() => {
      expect(screen.queryByText("Discard changes?")).toBeNull()
      expect(screen.queryByLabelText("Condition value")).toBeNull()
    })
  })

  it("reopens a saved rule with empty fields", async () => {
    saveIgnoreRule.mockResolvedValue({ rule: {}, ignored: 2 })
    open()
    fireEvent.click(screen.getByRole("button", { name: "Shopify" }))
    fireEvent.change(screen.getByLabelText("Condition value"), {
      target: { value: "GC-" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }))
    await waitFor(() => expect(saveIgnoreRule).toHaveBeenCalled())

    fireEvent.click(screen.getByRole("button", { name: "New rule" }))

    const value = (await screen.findByLabelText(
      "Condition value"
    )) as HTMLInputElement
    expect(value.value).toBe("")
  })
})
