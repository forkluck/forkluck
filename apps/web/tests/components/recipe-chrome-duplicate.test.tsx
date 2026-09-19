// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { duplicateRecipe, go, toastAdd } = vi.hoisted(() => ({
  duplicateRecipe: vi.fn(),
  go: vi.fn(),
  toastAdd: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/recipes/rcp_1/recipe",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  duplicateRecipe,
  shareRecipe: vi.fn(),
  updateRecipeShare: vi.fn(),
  removeRecipeShare: vi.fn(),
  removeRecipeGuestLink: vi.fn(),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))
vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({ go, pending: false }),
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function chrome(canDelete: boolean) {
  render(
    <RecipeChrome
      id="rec-1"
      title="Paste"
      publicId="rcp_1"
      canEdit
      canDelete={canDelete}
    >
      <div />
    </RecipeChrome>
  )
  fireEvent.click(screen.getByRole("button", { name: "Actions" }))
}

describe("Duplicate in the recipe page header menu", () => {
  it("is the owner's, and opens the copy", async () => {
    duplicateRecipe.mockResolvedValue({
      id: "rec-2",
      publicId: "rcp_copy",
      code: "R2",
      editVersion: 0,
    })
    chrome(true)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }))

    await waitFor(() =>
      expect(go).toHaveBeenCalledWith("/recipes/rcp_copy/recipe")
    )
    expect(duplicateRecipe).toHaveBeenCalledWith("rec-1")
    expect(toastAdd).toHaveBeenCalledWith({ title: "Duplicated Paste" })
  })

  it("is not offered to a shared editor", async () => {
    chrome(false)
    await screen.findByRole("menuitem", { name: "Import recipe…" })
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull()
  })
})
