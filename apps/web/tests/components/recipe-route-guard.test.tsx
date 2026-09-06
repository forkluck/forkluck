// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  deleteRecipeComment: vi.fn(),
  removeRecipeShare: vi.fn(),
  saveRecipe: vi.fn(),
  saveRecipeAggregate: vi.fn(),
  saveRecipeComment: vi.fn(),
  shareRecipe: vi.fn(),
  updateRecipeShare: vi.fn(),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  activateCatalogIngredient: vi.fn(),
  saveIngredient: vi.fn(),
  savePreparation: vi.fn(),
  saveRecipeLineMatch: vi.fn(),
  searchCatalogIngredients: vi.fn().mockResolvedValue({ items: [] }),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/recipes/abc123/recipe",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "metric",
  }),
}))

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
import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"
import { PrimoResultCard } from "@/components/primo/primo-result-card"
import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome } from "@/components/recipes/recipe-chrome"
import type { RecipeCostDiff, RecipeDetail } from "@/lib/backend/types"

const SAVED = {
  id: "rec-1",
  publicId: "abc123",
  userId: "owner-1",
  editVersion: 4,
  title: "Focaccia",
  description: "",
  status: "active",
  category: "",
  permission: "owner",
  canEdit: true,
  yieldAmount: null,
  yieldUnit: "pcs",
  servingAmount: null,
  servingUnit: "",
  shelfLifeAmount: null,
  shelfLifeUnit: "",
  autoSumYieldEnabled: false,
  percentageMode: "",
  percentIngredientEnabled: false,
  percentIngredientType: "",
  items: [],
  steps: [],
  equivalency: null,
  tags: [],
  comments: [],
  ingredientOptions: [],
  recipeOptions: [],
} as unknown as RecipeDetail

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

function dirtyRecipeScreen() {
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
      <RecipeChrome
        id={SAVED.id}
        publicId={SAVED.publicId}
        title={SAVED.title}
        canViewCost
      >
        <RecipeEditor
          currentUserId="user-1"
          initial={SAVED}
          sources={{ items: [], recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
      <PrimoResultCard result={COST_DIFF} onSuggestion={vi.fn()} />
    </NavigationBlockerProvider>
  )
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: "Slow rise" },
  })
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, "", "/recipes/abc123/recipe")
})

afterEach(cleanup)

/** Every way off this route, and where each one is drawn. */
const EXITS = [
  ["the sidebar", "/ingredients"],
  ["the breadcrumb", "/recipes"],
  ["the tab bar", "/recipes/abc123/nutrition"],
  ["the Primo rail's line", "/ingredients/ing_flour"],
  ["the Primo rail's card", "/recipes/rcp_other/cost"],
] as const

describe("the exits from a dirty recipe", () => {
  for (const [where, href] of EXITS) {
    it(`asks before ${where} takes the cook away`, () => {
      dirtyRecipeScreen()

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
    dirtyRecipeScreen()

    expect(screen.getByTestId("blocked").textContent).toBe("true")
  })
})
