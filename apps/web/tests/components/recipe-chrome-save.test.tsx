// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  usePathname: () => "/recipes/rcp_1/nutrition",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  shareRecipe: vi.fn(),
  updateRecipeShare: vi.fn(),
  removeRecipeShare: vi.fn(),
  removeRecipeGuestLink: vi.fn(),
}))
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))
vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
  }: {
    href: string
    children?: React.ReactNode
  }) => <a href={href}>{children}</a>,
  useNavigationBlocker: () => ({
    setIsBlocked: vi.fn(),
    allowNavigation: vi.fn(),
  }),
}))
vi.mock("@/components/recipes/share-dialog", () => ({
  ShareDialog: () => null,
}))

import { RecipeChrome } from "@/components/recipes/recipe-chrome"

afterEach(cleanup)

/** The tab under the header streams in; the header may not wait for it. */
function chrome(canEdit: boolean) {
  render(
    <RecipeChrome id="rec-1" title="Paste" publicId="rcp_1" canEdit={canEdit}>
      <div />
    </RecipeChrome>
  )
}

describe("the recipe header before its tab has loaded", () => {
  it("draws Save for whoever may edit", () => {
    chrome(true)
    expect(screen.getByRole("button", { name: "Save" })).not.toBeNull()
  })

  it("draws none for a viewer", () => {
    chrome(false)
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
  })
})
