// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { updateIngredientNutritionSettings, refresh } = vi.hoisted(() => ({
  updateIngredientNutritionSettings: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/ingredients/ing_1/ingredient",
  useRouter: () => ({ refresh, push: vi.fn() }),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  archiveIngredient: vi.fn(),
  deletePreparations: vi.fn(),
  savePreparation: vi.fn(),
  updateIngredientNutritionSettings,
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

function chrome(nonEdible: boolean) {
  render(
    <IngredientChrome
      id="ing-1"
      name="Takeout box"
      publicId="ing_1"
      nonEdible={nonEdible}
    >
      <div />
    </IngredientChrome>
  )
}

afterEach(() => {
  cleanup()
  updateIngredientNutritionSettings.mockReset()
  refresh.mockReset()
})

describe("a supply's chrome", () => {
  it("browses under Supplies and drops the tab strip", () => {
    chrome(true)

    expect(screen.getByText("Supplies").getAttribute("href")).toBe("/supplies")
    expect(screen.queryByText("Ingredients")).toBeNull()
    // Everything a supply has is on the one page, so no tab names it.
    for (const tab of ["Ingredient", "Supply", "Cost", "Nutrition"]) {
      expect(screen.queryByRole("link", { name: tab })).toBeNull()
    }
  })

  it("offers conversion instead of preparations", () => {
    chrome(true)
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }))

    expect(screen.queryByText("Add preparation")).toBeNull()
    expect(screen.getByText("Convert to ingredient")).not.toBeNull()
    expect(screen.getByText("Archive supply")).not.toBeNull()
  })

  it("writes the flag once the conversion is confirmed", async () => {
    updateIngredientNutritionSettings.mockResolvedValue({ ok: true })
    chrome(true)
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }))
    fireEvent.click(screen.getByText("Convert to ingredient"))

    // Nothing is written until the dialog is confirmed.
    expect(updateIngredientNutritionSettings).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "Convert to ingredient" })
    )

    await waitFor(() =>
      expect(updateIngredientNutritionSettings).toHaveBeenCalledWith("ing-1", {
        nonEdible: false,
      })
    )
    // The action revalidates, so its answer is the refresh.
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("an ingredient's chrome", () => {
  it("keeps preparations and offers the other conversion", () => {
    chrome(false)
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }))

    expect(screen.getByText("Add preparation")).not.toBeNull()
    expect(screen.getByText("Convert to supply")).not.toBeNull()
    for (const tab of ["Ingredient", "Cost", "Nutrition"]) {
      expect(screen.getByRole("link", { name: tab }).getAttribute("href")).toBe(
        `/ingredients/ing_1/${tab.toLowerCase()}`
      )
    }
  })
})
