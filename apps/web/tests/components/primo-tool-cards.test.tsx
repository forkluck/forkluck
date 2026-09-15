// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const { createRecipeFromDraft } = vi.hoisted(() => ({
  createRecipeFromDraft: vi.fn(),
}))

vi.mock("@/app/(app)/recipes/actions", () => ({ createRecipeFromDraft }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

import { PrimoRecipeDraftCard } from "@/components/primo/primo-recipe-draft-card"
import type { RecipeDraft } from "@/lib/recipe/draft"

const draft: RecipeDraft = {
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
  createRecipeFromDraft.mockReset()
})

afterEach(cleanup)

describe("Primo tool cards", () => {
  it("does not write before confirmation and links from the saved public id", async () => {
    createRecipeFromDraft.mockResolvedValue({
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
    expect(createRecipeFromDraft).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Create recipe" }))

    await waitFor(() =>
      expect(createRecipeFromDraft).toHaveBeenCalledWith(draft)
    )
    const link = await screen.findByRole("link", { name: "Open recipe" })
    expect(link.getAttribute("href")).toBe("/recipes/rcp_0123456789ab/recipe")
    expect(screen.getByRole("status").textContent).toContain("Recipe created")
  })

  it("keeps the review card actionable when creation fails", async () => {
    createRecipeFromDraft.mockResolvedValue({
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
