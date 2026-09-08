// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const { deleteRecipe, updateRecipeStatus, toastAdd } = vi.hoisted(() => ({
  deleteRecipe: vi.fn(),
  updateRecipeStatus: vi.fn(),
  toastAdd: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe,
  deleteRecipes: vi.fn(),
  duplicateRecipe: vi.fn(),
  updateRecipeStatus,
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))
vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
  }: {
    href: string
    children?: React.ReactNode
  }) => <a href={href}>{children}</a>,
  useGuardedNavigate: () => ({ go: vi.fn(), pending: false }),
  useNavigationBlocker: () => ({
    allowNavigation: vi.fn(),
    confirmNavigation: vi.fn(),
  }),
}))

import { RecipesTable } from "@/components/recipes/recipes-table"
import type { RecipeHealth } from "@/lib/recipe/health"

const recipe = (partial: Partial<RecipeHealth>): RecipeHealth =>
  ({
    id: "rec-1",
    publicId: "abc123",
    title: "Focaccia, sea salt",
    code: "R1",
    kind: "recipe",
    status: "active",
    categoryId: null,
    category: "pastry",
    updatedAt: new Date("2026-02-03T10:00:00Z"),
    ingredientCents: 125,
    menuPriceCents: 400,
    foodCost: 0.3125,
    overTarget: false,
    suffix: "/pc",
    issues: [],
    labor: null,
    ...partial,
  }) as RecipeHealth

/** A promise the test settles by hand, standing in for the server. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function openRowMenu(name: string) {
  fireEvent.click(
    screen.getAllByRole("button", { name: `Actions for ${name}` })[0]!
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/**
 * AGENTS.md "Feedback": nothing on screen changes before the server has
 * answered, then the row goes, the confirmation leaves, and the toast says
 * so. The table once hid the row and closed the dialog before the request
 * went out, which read as instant and then reversed itself on failure.
 */
describe("deleting a recipe from its row", () => {
  it("keeps the row and the confirmation until the server answers", async () => {
    const answer = deferred<{ ok: true }>()
    deleteRecipe.mockReturnValue(answer.promise)
    render(<RecipesTable rows={[recipe({})]} currencyCode="USD" />)

    await openRowMenu("Focaccia, sea salt")
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete recipe" })
    )

    // In flight: the confirm spins, the row is still there, nothing said.
    const busy = await screen.findByRole("button", { name: /Deleting/ })
    expect(busy.getAttribute("aria-busy")).toBe("true")
    expect(screen.getByText("Focaccia, sea salt")).toBeTruthy()
    expect(screen.getByText("Delete this recipe?")).toBeTruthy()
    expect(toastAdd).not.toHaveBeenCalled()

    await act(async () => answer.resolve({ ok: true }))

    await waitFor(() =>
      expect(screen.queryByText("Focaccia, sea salt")).toBeNull()
    )
    expect(screen.queryByText("Delete this recipe?")).toBeNull()
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Deleted Focaccia, sea salt",
    })
  })

  it("leaves the row and the confirmation in place when the delete is refused", async () => {
    deleteRecipe.mockResolvedValue({ error: "Focaccia is on a menu." })
    render(<RecipesTable rows={[recipe({})]} currencyCode="USD" />)

    await openRowMenu("Focaccia, sea salt")
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete recipe" })
    )

    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({
        title: "Focaccia is on a menu.",
        type: "error",
      })
    )
    expect(screen.getByText("Focaccia, sea salt")).toBeTruthy()
    expect(screen.getByText("Delete this recipe?")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Delete recipe" })).toBeTruthy()
  })
})

describe("archiving a recipe from its row", () => {
  it("shows the wait on the row, changes nothing early, and reports", async () => {
    const answer = deferred<{ ok: true }>()
    updateRecipeStatus.mockReturnValue(answer.promise)
    render(<RecipesTable rows={[recipe({})]} currencyCode="USD" />)

    await openRowMenu("Focaccia, sea salt")
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }))

    await waitFor(() =>
      expect(updateRecipeStatus).toHaveBeenCalledWith("rec-1", "archived")
    )
    // The menu has closed, so the row itself carries the wait.
    // The menu has closed, so the row itself carries the wait.
    const mark = await screen.findByText("Working")
    expect(mark.closest('[role="status"]')).not.toBeNull()
    expect(screen.queryByText("Archived")).toBeNull()

    await act(async () => answer.resolve({ ok: true }))

    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({
        title: "Archived Focaccia, sea salt",
      })
    )
    await waitFor(() => expect(screen.queryByText("Working")).toBeNull())
  })
})
