// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const state = vi.hoisted(() => ({ search: "batch=6" }))
const push = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  usePathname: () => "/recipes/rcp_0123456789ab/cost",
  useSearchParams: () => new URLSearchParams(state.search),
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
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
  useGuardedNavigate: () => ({ go: vi.fn(), pending: false }),
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

import { RecipeChrome, useRecipeEdit } from "@/components/recipes/recipe-chrome"

function BatchProbe() {
  const { batch, setBatch } = useRecipeEdit()
  return (
    <div>
      <output>{`${batch.label}|${batch.scale}`}</output>
      <button
        type="button"
        onClick={() => setBatch({ label: "3x", scale: 3, isOriginal: false })}
      >
        Manual batch
      </button>
    </div>
  )
}

function renderChrome() {
  return render(
    <RecipeChrome
      id="recipe-1"
      title="Mooncake"
      publicId="rcp_0123456789ab"
      canViewCost
    >
      <BatchProbe />
    </RecipeChrome>
  )
}

afterEach(cleanup)

describe("recipe batch URL lens", () => {
  it("sets the batch on mount and when the parameter changes", async () => {
    state.search = "batch=6"
    const view = renderChrome()
    await screen.findByText("6x|6")
    state.search = "batch=12"
    view.rerender(
      <RecipeChrome
        id="recipe-1"
        title="Mooncake"
        publicId="rcp_0123456789ab"
        canViewCost
      >
        <BatchProbe />
      </RecipeChrome>
    )
    await screen.findByText("12x|12")
  })

  it("ignores invalid factors and manual changes do not write the URL", async () => {
    state.search = "batch=abc"
    const view = renderChrome()
    expect(screen.getByText("1x|1")).toBeDefined()
    state.search = "batch=0"
    view.rerender(
      <RecipeChrome
        id="recipe-1"
        title="Mooncake"
        publicId="rcp_0123456789ab"
        canViewCost
      >
        <BatchProbe />
      </RecipeChrome>
    )
    await waitFor(() => expect(screen.getByText("1x|1")).toBeDefined())
    fireEvent.click(screen.getByRole("button", { name: "Manual batch" }))
    expect(screen.getByText("3x|3")).toBeDefined()
    expect(push).not.toHaveBeenCalled()
  })
})
