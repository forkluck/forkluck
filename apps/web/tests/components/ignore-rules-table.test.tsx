// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const deleteIgnoreRule = vi.fn()
const saveIgnoreRule = vi.fn()
const previewIgnoreRule = vi.fn()

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/products/actions", () => ({
  deleteIgnoreRule: (...args: unknown[]) => deleteIgnoreRule(...args),
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

import { IgnoreRulesTable } from "@/components/menu/ignore-rules-table"
import type { SalesIgnoreRuleRow } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function rule(overrides: Partial<SalesIgnoreRuleRow> = {}): SalesIgnoreRuleRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    channel: "square",
    enabled: true,
    conditions: [{ field: "sku", operator: "starts_with", value: "GC-" }],
    ignoredCount: 3,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  }
}

describe("IgnoreRulesTable", () => {
  it("invites a first rule when none exist", () => {
    render(<IgnoreRulesTable rules={[]} />)
    expect(screen.getByText("Create auto-ignore rules")).toBeTruthy()
  })

  it("reads a rule's conditions back as its name", () => {
    render(
      <IgnoreRulesTable
        rules={[
          rule({
            conditions: [
              { field: "sku", operator: "starts_with", value: "GC-" },
              { field: "title", operator: "contains", value: "card" },
            ],
          }),
        ]}
      />
    )
    expect(
      screen.getByText("SKU starts with “GC-” and Title contains “card”")
    ).toBeTruthy()
  })

  it("names a rule that covers every channel", () => {
    render(<IgnoreRulesTable rules={[rule({ channel: null })]} />)
    expect(screen.getByText("All channels")).toBeTruthy()
  })

  it("shows how many products a rule currently holds", () => {
    render(<IgnoreRulesTable rules={[rule({ ignoredCount: 12 })]} />)
    expect(screen.getByText("12")).toBeTruthy()
  })

  it("disabling a rule keeps its conditions so nothing is lost", () => {
    saveIgnoreRule.mockResolvedValue({ rule: rule(), ignored: 0 })
    const row = rule()
    render(<IgnoreRulesTable rules={[row]} />)

    fireEvent.click(screen.getByRole("switch"))

    expect(saveIgnoreRule).toHaveBeenCalledWith({
      id: row.id,
      channel: "square",
      enabled: false,
      conditions: row.conditions,
    })
  })

  it("warns what a delete puts back before doing it", () => {
    render(<IgnoreRulesTable rules={[rule({ ignoredCount: 4 })]} />)
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    expect(screen.getByText(/4 products return to Catalog/)).toBeTruthy()
    expect(deleteIgnoreRule).not.toHaveBeenCalled()
  })

  it("filters by channel", () => {
    render(
      <IgnoreRulesTable
        rules={[
          rule({ channel: "square" }),
          rule({
            id: "22222222-2222-4222-8222-222222222222",
            channel: "shopify",
            conditions: [{ field: "title", operator: "is", value: "Delivery" }],
          }),
        ]}
      />
    )
    expect(screen.getAllByRole("switch")).toHaveLength(2)
  })
})
