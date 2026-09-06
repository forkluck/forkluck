// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  saveInvoice: vi.fn(),
  reviewInvoiceLine: vi.fn(),
  deleteInvoice: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/invoices/inv_1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))

vi.mock("@/components/app-search", () => ({ AppSearch: () => null }))
vi.mock("@/components/sidebar-account", () => ({ SidebarAccount: () => null }))
vi.mock("@/components/kitchen-switcher", () => ({
  KitchenSwitcher: () => null,
}))

// The real provider, with the guarded link marked so a raw `next/link` on any
// of these exits shows up as an unmarked anchor.
vi.mock("@/components/navigation-blocker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/navigation-blocker")>()
  return {
    ...actual,
    GuardedLink: ({
      href,
      children,
      ...rest
    }: React.ComponentProps<"a"> & { href: string }) => (
      <a href={href} data-guarded="" {...rest}>
        {children}
      </a>
    ),
  }
})

window.matchMedia = ((query: string) => ({
  matches: true,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})) as unknown as typeof window.matchMedia

import { AppSidebar } from "@/components/app-sidebar"
import { InvoiceChrome } from "@/components/invoices/invoice-chrome"
import { InvoiceEditor } from "@/components/invoices/invoice-editor"
import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"
import { PrimoResultCard } from "@/components/primo/primo-result-card"
import type { InvoiceDetail } from "@/lib/backend/schemas"
import type { RecipeCostDiff } from "@/lib/backend/types"

const DETAIL: InvoiceDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  publicId: "inv_1",
  editVersion: 2,
  supplier: "local-farm",
  supplierName: "Local Farm",
  documentType: "invoice",
  invoiceNumber: "A-1",
  invoiceDate: "2026-08-12",
  dueDate: null,
  totalCents: 0,
  taxCents: 0,
  subtotalCents: null,
  notes: "",
  paymentMethod: "",
  currencyCode: "USD",
  source: "manual",
  fileName: "",
  driveWebViewLink: "",
  driveFileId: null,
  driveFilePart: null,
  documentKey: null,
  lineCount: 0,
  matchedLineCount: 0,
  unresolvedLineCount: 0,
  createdAt: new Date("2026-08-12T00:00:00Z"),
  lines: [],
}

/** The rail's card: it is mounted on every screen, this route included. */
const COST_DIFF = {
  recipe: { id: "rec-2", publicId: "rcp_other", title: "Butter cake" },
  window: {
    fromAt: "2026-05-26T00:00:00+00:00",
    toAt: "2026-08-24T18:30:00+00:00",
    fromDate: "2026-05-26",
    toDate: "2026-08-24",
    days: 90,
    source: "default90Days",
    comparison: "priceOnlyCurrentRecipeBasis",
  },
  basis: "Price-only comparison using the current recipe.",
  currencyCode: "USD",
  totals: { fromCents: 1000, toCents: 1100, deltaCents: 100 },
  coverage: { totalLines: 1, comparedLines: 1, skippedLines: 0 },
  lines: [
    {
      itemId: "line-1",
      kind: "ingredient",
      name: "Flour",
      ingredientPublicId: "ing_flour",
      deltaCents: 100,
      from: {
        status: "priced",
        costCents: 1000,
        unitCostCents: 10,
        effectiveAt: null,
        source: null,
        supplier: null,
      },
      to: {
        status: "priced",
        costCents: 1100,
        unitCostCents: 11,
        effectiveAt: null,
        source: null,
        supplier: null,
      },
    },
  ],
  priceChangesInWindow: 1,
  lastChangeBeforeWindow: null,
  omittedLines: 0,
} as unknown as RecipeCostDiff

/** What every guarded exit reads before it lets go. */
function BlockedProbe() {
  const { isBlocked } = useNavigationBlocker()
  return <span data-testid="blocked">{String(isBlocked)}</span>
}

function dirtyInvoiceScreen() {
  render(
    <NavigationBlockerProvider>
      <BlockedProbe />
      <AppSidebar
        user={
          { id: "user-1", email: "chef@example.com", name: "Chef" } as never
        }
        open
        onOpenChange={vi.fn()}
      />
      <InvoiceChrome title="A-1" id={DETAIL.id} publicId={DETAIL.publicId}>
        <InvoiceEditor
          initial={DETAIL}
          supplierNames={["Local Farm"]}
          ingredients={[]}
          categories={[]}
          paymentMethods={[]}
          currentUserId="user-1"
        />
      </InvoiceChrome>
      <PrimoResultCard result={COST_DIFF} onSuggestion={vi.fn()} />
    </NavigationBlockerProvider>
  )
  fireEvent.change(screen.getByLabelText("Number"), {
    target: { value: "A-2" },
  })
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, "", "/invoices/inv_1")
})

afterEach(cleanup)

/** Every way off this route, and where each one is drawn. */
const EXITS = [
  ["the sidebar", "/ingredients"],
  ["the breadcrumb", "/invoices"],
  ["the Primo rail's line", "/ingredients/ing_flour"],
  ["the Primo rail's card", "/recipes/rcp_other/cost"],
] as const

describe("the exits from a dirty invoice", () => {
  for (const [where, href] of EXITS) {
    it(`asks before ${where} takes the cook away`, () => {
      dirtyInvoiceScreen()

      const links = Array.from(
        document.querySelectorAll(`a[href="${href}"]`)
      ) as HTMLAnchorElement[]

      expect(links.length).toBeGreaterThan(0)
      for (const link of links) {
        expect(link.hasAttribute("data-guarded")).toBe(true)
      }
    })
  }

  it("is what the editor turns on the moment it holds unsaved work", () => {
    dirtyInvoiceScreen()

    expect(screen.getByTestId("blocked").textContent).toBe("true")
  })
})
