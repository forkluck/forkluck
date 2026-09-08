// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { archiveIngredient, refresh } = vi.hoisted(() => ({
  archiveIngredient: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/ingredients/ing_1/ingredient",
  useRouter: () => ({ refresh, push: vi.fn() }),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  archiveIngredient,
  deletePreparations: vi.fn(),
  resetIngredientConversion: vi.fn(),
  saveIngredientConversion: vi.fn(),
  savePreparation: vi.fn(),
}))

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

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))

// The dialogs are lazy surfaces the header only mounts on demand; the menu is
// what this test is about.
vi.mock("@/components/ingredients/ingredient-delete-dialog", () => ({
  IngredientDeleteDialog: () => null,
}))
vi.mock("@/components/ingredients/preparation-dialog", () => ({
  PreparationDialog: () => null,
}))
vi.mock("@/components/ingredients/purchase-unit-dialog", () => ({
  PurchaseUnitDialog: () => null,
}))

import { IngredientChrome } from "@/components/ingredients/ingredient-chrome"

function open(status: "active" | "archived") {
  render(
    <IngredientChrome id="ing-1" name="Butter" publicId="ing_1" status={status}>
      <div />
    </IngredientChrome>
  )
  fireEvent.click(screen.getByRole("button", { name: /Actions/ }))
}

afterEach(cleanup)

describe("the ingredient tabs", () => {
  it("links to the Nutrition tab", () => {
    render(
      <IngredientChrome id="ing-1" name="Butter" publicId="ing_1">
        <div />
      </IngredientChrome>
    )
    expect(
      screen.getByRole("link", { name: "Nutrition" }).getAttribute("href")
    ).toBe("/ingredients/ing_1/nutrition")
  })
})

describe("archiving an ingredient from its header", () => {
  it("archives an active ingredient", async () => {
    archiveIngredient.mockResolvedValue({ item: {} })
    open("active")

    expect(screen.queryByText("Archived")).toBeNull()
    fireEvent.click(screen.getByText("Archive ingredient"))

    await waitFor(() =>
      expect(archiveIngredient).toHaveBeenCalledWith("ing-1", true)
    )
    // The action revalidates, so its answer is the refresh.
    expect(refresh).not.toHaveBeenCalled()
  })

  it("restores an archived one and says it is archived", async () => {
    archiveIngredient.mockResolvedValue({ item: {} })
    open("archived")

    expect(screen.getByText("Archived")).not.toBeNull()
    fireEvent.click(screen.getByText("Restore ingredient"))

    await waitFor(() =>
      expect(archiveIngredient).toHaveBeenCalledWith("ing-1", false)
    )
    expect(refresh).not.toHaveBeenCalled()
  })
})
