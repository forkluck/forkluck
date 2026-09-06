// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const { createPrimoRecipe } = vi.hoisted(() => ({
  createPrimoRecipe: vi.fn(),
}))

vi.mock("@/app/(app)/recipes/actions", () => ({ createPrimoRecipe }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

import { PrimoRecipeDraftCard } from "@/components/primo/primo-recipe-draft-card"
import { PrimoUsdaResultCard } from "@/components/primo/primo-usda-result-card"
import type { PrimoRecipeDraft } from "@/lib/primo/recipe"

const draft: PrimoRecipeDraft = {
  title: "Garlic soup",
  description: "A simple pantry soup.",
  yield: { amount: 4, unit: "pcs" },
  ingredients: [
    {
      name: "Garlic",
      quantity: 2,
      unit: "head",
      preparation: "peeled",
    },
    {
      name: "Salt",
      quantity: null,
      unit: "",
      preparation: "to taste",
    },
  ],
  steps: ["Simmer the garlic until tender.", "Blend until smooth."],
}

beforeEach(() => {
  createPrimoRecipe.mockReset()
})

afterEach(cleanup)

describe("Primo tool cards", () => {
  it("shows USDA candidates and their authoritative identifiers", () => {
    render(
      <PrimoUsdaResultCard
        result={{
          query: "garlic",
          scope: "common",
          items: [
            {
              fdcId: 1104647,
              description: "Garlic, raw",
              dataType: "Foundation",
              brand: "",
            },
            {
              fdcId: 1999999,
              description: "GARLIC SAUCE",
              dataType: "Branded",
              brand: "Example Foods",
            },
          ],
        }}
      />
    )

    expect(screen.getByText("USDA FoodData Central")).toBeDefined()
    expect(screen.getByText("Garlic, raw")).toBeDefined()
    expect(screen.getByText("Foundation · FDC 1104647")).toBeDefined()
    expect(screen.getByText("Example Foods")).toBeDefined()
  })

  it("makes an empty USDA search explicit", () => {
    render(
      <PrimoUsdaResultCard
        result={{ query: "unknown food", scope: "branded", items: [] }}
      />
    )

    expect(
      screen.getByText(
        "No branded USDA foods matched “unknown food”. Try broader wording."
      )
    ).toBeDefined()
  })

  it("does not write before confirmation and links from the saved public id", async () => {
    createPrimoRecipe.mockResolvedValue({
      id: "42",
      publicId: "rcp_0123456789ab",
      code: "R-42",
      editVersion: 0,
    })
    render(<PrimoRecipeDraftCard draft={draft} />)

    expect(screen.getByText("Total yield:").parentElement?.textContent).toBe(
      "Total yield: 4 pieces"
    )
    expect(screen.getByText("Unmeasured")).toBeDefined()
    expect(createPrimoRecipe).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Create recipe" }))

    await waitFor(() => expect(createPrimoRecipe).toHaveBeenCalledWith(draft))
    const link = await screen.findByRole("link", { name: "Open recipe" })
    expect(link.getAttribute("href")).toBe("/recipes/rcp_0123456789ab/recipe")
    expect(screen.getByRole("status").textContent).toContain("Recipe created")
  })

  it("keeps the review card actionable when creation fails", async () => {
    createPrimoRecipe.mockResolvedValue({
      error: "Couldn’t create the recipe.",
    })
    render(<PrimoRecipeDraftCard draft={draft} />)

    fireEvent.click(screen.getByRole("button", { name: "Create recipe" }))

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn’t create the recipe."
    )
    expect(screen.getByRole("button", { name: "Create recipe" })).toBeDefined()
    expect(screen.queryByRole("link", { name: "Open recipe" })).toBeNull()
  })
})
