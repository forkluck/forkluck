// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { archiveIngredient, refresh } = vi.hoisted(() => ({
  archiveIngredient: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/ingredients/ing_1/nutrition",
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

afterEach(cleanup)

describe("the Nutrition tab", () => {
  it("keeps the header's Save", () => {
    render(
      <IngredientChrome id="ing-1" name="Butter" publicId="ing_1">
        <div />
      </IngredientChrome>
    )
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })
})
