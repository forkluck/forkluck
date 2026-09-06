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
import { IgnoreRuleDialog } from "@/components/menu/ignore-rule-dialog"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function open() {
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
  render(<IgnoreRuleDialog trigger={<Button>New rule</Button>} />)
  fireEvent.click(screen.getByRole("button", { name: "New rule" }))
}

describe("IgnoreRuleDialog required condition (never grey)", () => {
  it("leaves Save rule enabled with no condition value", () => {
    open()
    expect(
      (screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("blocks save and shows an error when no condition has a value", () => {
    open()
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }))
    expect(saveIgnoreRule).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a value for at least one condition."
    )
  })

  it("saves once a condition has a value", async () => {
    saveIgnoreRule.mockResolvedValue({ rule: {}, ignored: 0 })
    open()
    fireEvent.change(screen.getByLabelText("Condition value"), {
      target: { value: "GC-" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }))
    await waitFor(() => {
      expect(saveIgnoreRule).toHaveBeenCalled()
    })
  })
})
