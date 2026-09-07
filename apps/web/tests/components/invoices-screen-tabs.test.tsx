// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const { navigation, push, replace } = vi.hoisted(() => ({
  navigation: { query: "" },
  push: vi.fn(),
  replace: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/invoices/actions", () => ({ deleteInvoice: vi.fn() }))
vi.mock("@/app/(app)/actions", () => ({ loadIngredientOptions: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh: vi.fn(), push }),
  usePathname: () => "/invoices",
  useSearchParams: () => new URLSearchParams(navigation.query),
}))
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))
vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({
    go: async (href: string, options?: { replace?: boolean }) => {
      ;(options?.replace ? replace : push)(href)
      return true
    },
    pending: false,
  }),
  GuardedLink: ({
    href,
    children,
    ...props
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

import { InvoicesScreen } from "@/components/invoices/invoices-screen"
import type { InvoiceRow, InvoicesOverview } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  navigation.query = ""
})

function invoice(partial: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv-1",
    publicId: "inv_1",
    supplier: "acme",
    supplierName: "Acme Produce",
    documentType: "invoice",
    invoiceNumber: "B-1001",
    invoiceDate: "2026-08-09",
    currencyCode: "USD",
    totalCents: 12500,
    taxCents: 0,
    lineCount: 8,
    matchedLineCount: 8,
    unresolvedLineCount: 0,
    issueKind: null,
    totalDeltaCents: 0,
    fileName: "",
    source: null,
    driveFileId: null,
    driveWebViewLink: null,
    createdAt: new Date("2026-08-09T00:00:00Z"),
    updatedAt: new Date("2026-08-09T00:00:00Z"),
    ...partial,
  }
}

function overview(partial: Partial<InvoicesOverview> = {}): InvoicesOverview {
  return {
    aiUsage: {
      usedPages: 0,
      maxPages: 10,
      resetsOn: "2026-09-01",
      exhausted: false,
    },
    months: [{ month: "2026-08", totals: [] }],
    month: "2026-08",
    needsReviewCount: 3,
    summary: [
      {
        currencyCode: "USD",
        totalCents: 390500,
        invoiceCount: 4,
        lineCount: 22,
        creditCents: 0,
      },
    ],
    byCategory: [
      {
        categoryId: "cat-produce",
        name: "Produce",
        currencyCode: "USD",
        totalCents: 300000,
        lineCount: 18,
      },
      {
        categoryId: "cat-paper",
        name: "Paper goods",
        currencyCode: "USD",
        totalCents: 90500,
        lineCount: 4,
      },
    ],
    bySupplier: [
      {
        supplier: "metro",
        supplierName: "Metro Meats",
        currencyCode: "USD",
        totalCents: 250000,
        invoiceCount: 2,
      },
    ],
    invoices: [invoice()],
    categories: [
      {
        id: "cat-produce",
        name: "Produce",
        isIngredient: true,
        isSupply: false,
        position: 1,
      },
      {
        id: "cat-paper",
        name: "Paper goods",
        isIngredient: false,
        isSupply: true,
        position: 2,
      },
    ],
    driveNewCount: 0,
    driveReadyCount: 0,
    aiKey: { configured: false, hint: null },
    connectors: { configured: false, providers: [], connections: [] },
    ...partial,
  }
}

function screenFor(
  props: Partial<React.ComponentProps<typeof InvoicesScreen>>
) {
  return render(
    <InvoicesScreen
      overview={overview()}
      query=""
      tab={null}
      byok={false}
      driveConfig={null}
      driveConnectHref={null}
      {...props}
    />
  )
}

describe("the invoices screen's tabs", () => {
  it("shows exhausted AI usage without disabling ordinary invoice entry", () => {
    screenFor({
      overview: overview({
        aiUsage: {
          usedPages: 10,
          maxPages: 10,
          resetsOn: "2026-10-01",
          exhausted: true,
        },
      }),
    })
    expect(screen.getByRole("status").textContent).toContain(
      "10 of 10 AI pages used. Resets October 1."
    )
    expect(screen.getByRole("status").textContent).toContain(
      "enter invoices manually"
    )
    expect(
      screen.getByRole("link", { name: "Upgrade" }).getAttribute("href")
    ).toBe("/subscribe")
    expect(
      screen.getByRole("link", { name: "New invoice" }).getAttribute("href")
    ).toBe("/invoices/new")
  })

  it("does not show a hosted AI allowance for BYOK", () => {
    screenFor({ byok: true })
    expect(screen.queryByText(/AI pages used/)).toBeNull()
  })
  it("counts the whole workspace's attention rows on its own tab", () => {
    screenFor({})
    const attention = screen.getByRole("link", {
      name: "Needs attention (3)",
    })
    expect(attention.getAttribute("href")).toBe("/invoices?tab=attention")
    expect(screen.getByRole("link", { name: "All" }).getAttribute("href")).toBe(
      "/invoices"
    )
    // The banner the tab replaced is gone.
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull()
  })

  it("offers the Drive inbox from the toolbar only while receipts wait in it", () => {
    screenFor({ overview: overview({ driveReadyCount: 7 }) })
    expect(screen.getByRole("button", { name: "Review (7)" })).toBeTruthy()
    cleanup()
    screenFor({ overview: overview({ driveReadyCount: 0 }) })
    expect(screen.queryByRole("button", { name: /^Review/ })).toBeNull()
  })

  it("drops the month picker and the month's spend under the attention tab", () => {
    screenFor({
      tab: "attention",
      overview: overview({
        months: [
          { month: "2026-08", totals: [] },
          { month: "2026-07", totals: [] },
        ],
      }),
    })
    expect(screen.queryByText("Total spend this month")).toBeNull()
    expect(screen.queryByLabelText(/^Month: /)).toBeNull()
  })

  it("writes what was typed into ?q= for the server to search", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    screenFor({})
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "acme" },
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(replace).toHaveBeenCalledWith("/invoices?q=acme", { scroll: false })
  })

  it("carries the selected month into the receipt's way back", () => {
    navigation.query = "month=2026-07"
    screenFor({
      overview: overview({ month: "2026-07" }),
    })

    // The name is a link of its own; the row click lands beside it.
    fireEvent.click(screen.getByText("Acme Produce").closest("tr")!)

    expect(push).toHaveBeenCalledWith(
      "/invoices/inv_1?returnTo=%2Finvoices%3Fmonth%3D2026-07"
    )
  })
})
