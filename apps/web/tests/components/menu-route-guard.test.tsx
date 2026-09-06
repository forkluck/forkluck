// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/app/(app)/menu/actions", () => ({
  saveMenu: vi.fn(),
  deleteMenu: vi.fn(),
  loadMenuProducts: vi.fn().mockResolvedValue({ items: [] }),
}))

vi.mock("@/app/(app)/recipes/actions", () => ({ saveRecipe: vi.fn() }))

vi.mock("@/app/(app)/products/actions", () => ({ saveSalesProduct: vi.fn() }))

vi.mock("next/navigation", () => ({
  usePathname: () => "/menu/mnu_x",
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
import { MenuChrome } from "@/components/menus/menu-chrome"
import { MenuEditor } from "@/components/menus/menu-editor"
import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"
import { PrimoResultCard } from "@/components/primo/primo-result-card"
import type { MenuDetail, RecipeCostDiff } from "@/lib/backend/types"

const DETAIL = {
  menu: {
    id: "menu-1",
    publicId: "mnu_x",
    editVersion: 2,
    name: "Spring",
    periodStart: null,
    periodEnd: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  items: [],
  recipes: [],
  products: [],
  currencyCode: "USD",
} as unknown as MenuDetail

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

function dirtyMenuScreen() {
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
      <MenuChrome title="Spring" publicId="mnu_x">
        <MenuEditor
          initial={DETAIL}
          recipes={[]}
          products={[]}
          currencyCode="USD"
          timeZone="UTC"
          currentUserId="user-1"
        />
      </MenuChrome>
      <PrimoResultCard result={COST_DIFF} onSuggestion={vi.fn()} />
    </NavigationBlockerProvider>
  )
  fireEvent.change(screen.getByLabelText("Name (required)"), {
    target: { value: "Spring tasting" },
  })
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, "", "/menu/mnu_x")
})

afterEach(cleanup)

/** Every way off this route, and where each one is drawn. */
const EXITS = [
  ["the sidebar", "/ingredients"],
  ["the breadcrumb", "/menu"],
  ["the Primo rail's line", "/ingredients/ing_flour"],
  ["the Primo rail's card", "/recipes/rcp_other/cost"],
] as const

describe("the exits from a dirty menu", () => {
  for (const [where, href] of EXITS) {
    it(`asks before ${where} takes the cook away`, () => {
      dirtyMenuScreen()

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
    dirtyMenuScreen()

    expect(screen.getByTestId("blocked").textContent).toBe("true")
  })
})
