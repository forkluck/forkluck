// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const { deleteIngredient } = vi.hoisted(() => ({
  deleteIngredient: vi.fn(),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  saveIngredient: vi.fn(),
  archiveIngredient: vi.fn(),
  deleteIngredient,
  deletePreparations: vi.fn(),
  savePreparation: vi.fn(),
  saveIngredientConversion: vi.fn(),
  resetIngredientConversion: vi.fn(),
  searchInvoiceItems: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/ingredients/ing_1/ingredient",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))

vi.mock("@/components/app-search", () => ({ AppSearch: () => null }))
vi.mock("@/components/sidebar-account", () => ({ SidebarAccount: () => null }))
vi.mock("@/components/kitchen-switcher", () => ({
  KitchenSwitcher: () => null,
}))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "metric",
  }),
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
import {
  IngredientChrome,
  useIngredientFormBinding,
} from "@/components/ingredients/ingredient-chrome"
import {
  IngredientForm,
  type IngredientFormValues,
} from "@/components/ingredients/ingredient-form"
import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"
import { PrimoResultCard } from "@/components/primo/primo-result-card"
import type { RecipeCostDiff } from "@/lib/backend/types"

const BUTTER: IngredientFormValues = {
  id: "ing-1",
  name: "Butter",
  category: null,
  editVersion: 2,
  purchaseCostCents: 500,
  purchaseSize: 1,
  purchaseUnit: "lb",
  priceSource: "user",
  tags: [],
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

function Panel() {
  const binding = useIngredientFormBinding()
  return (
    <IngredientForm
      {...binding}
      section="ingredient"
      profileLayout
      initial={BUTTER}
      onDone={vi.fn()}
    />
  )
}

function dirtyIngredientScreen() {
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
      <IngredientChrome id="ing-1" name="Butter" publicId="ing_1">
        <Panel />
      </IngredientChrome>
      <PrimoResultCard result={COST_DIFF} onSuggestion={vi.fn()} />
    </NavigationBlockerProvider>
  )
  fireEvent.change(screen.getByLabelText("Name (required)"), {
    target: { value: "Butter, unsalted" },
  })
}

afterEach(() => {
  cleanup()
  deleteIngredient.mockReset()
})

/** Every way off this route, and where each one is drawn. */
const EXITS = [
  ["the sidebar", "/recipes"],
  ["the breadcrumb", "/ingredients"],
  ["the Cost tab", "/ingredients/ing_1/cost"],
  ["the tab bar", "/ingredients/ing_1/nutrition"],
  ["the Primo rail's line", "/ingredients/ing_flour"],
  ["the Primo rail's card", "/recipes/rcp_other/cost"],
] as const

describe("the exits from a dirty ingredient", () => {
  for (const [where, href] of EXITS) {
    it(`asks before ${where} takes the cook away`, () => {
      dirtyIngredientScreen()

      const links = Array.from(
        document.querySelectorAll(`a[href="${href}"]`)
      ) as HTMLAnchorElement[]

      expect(links.length).toBeGreaterThan(0)
      for (const link of links) {
        expect(link.hasAttribute("data-guarded")).toBe(true)
      }
    })
  }

  it("asks before a recipe named by the delete dialog takes the cook away", async () => {
    deleteIngredient.mockResolvedValue({
      error: "Butter is used in recipes.",
      usedInRecipes: [{ id: "rec-1", publicId: "abc123", title: "Focaccia" }],
    })
    dirtyIngredientScreen()

    fireEvent.click(screen.getByRole("button", { name: /Actions/ }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete ingredient" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete ingredient" }))
    })

    const link = screen.getByRole("link", { name: "Focaccia" })
    expect(link.getAttribute("href")).toBe("/recipes/abc123")
    expect(link.hasAttribute("data-guarded")).toBe(true)
  })

  it("is what the form turns on the moment it holds unsaved work", () => {
    dirtyIngredientScreen()

    expect(screen.getByTestId("blocked").textContent).toBe("true")
  })
})
