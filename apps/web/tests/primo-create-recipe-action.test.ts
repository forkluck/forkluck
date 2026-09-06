import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  djangoAction: vi.fn(),
  getPricingEntries: vi.fn(),
  getRecipe: vi.fn(),
  refresh: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({
  refresh: mocks.refresh,
  revalidatePath: mocks.revalidatePath,
}))
vi.mock("@/lib/auth-session", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "user-1" }),
}))
vi.mock("@/lib/backend/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  djangoAction: (slug: string, body: unknown) => mocks.djangoAction(slug, body),
}))
vi.mock("@/lib/backend/queries", () => ({
  getPricingEntries: () => mocks.getPricingEntries(),
  getRecipe: (...args: unknown[]) => mocks.getRecipe(...args),
}))

const { createPrimoRecipe } = await import("@/app/(app)/recipes/actions")

const draft = {
  title: "Cream biscuits",
  description: "A quick test recipe.",
  yield: { amount: 12, unit: "slice" as const },
  ingredients: [
    {
      name: "all purpose flour",
      quantity: 250,
      unit: "g",
      preparation: "sifted",
    },
    {
      name: "Flour",
      quantity: 1,
      unit: "cup",
      preparation: "",
    },
    {
      name: "crème fraîche",
      quantity: null,
      unit: "",
      preparation: "to taste",
    },
  ],
  steps: ["Mix the dough.", "Bake until golden."],
}

function entry(
  id: string,
  name: string,
  extra: { status?: "active" | "archived"; nonEdible?: boolean } = {}
) {
  return { id, name, status: "active" as const, nonEdible: false, ...extra }
}

beforeEach(() => {
  mocks.djangoAction.mockReset()
  mocks.getPricingEntries.mockReset()
  mocks.getRecipe.mockReset()
  mocks.refresh.mockReset()
  mocks.revalidatePath.mockReset()
})

describe("createPrimoRecipe", () => {
  it("links normalized exact active names, leaves other lines unresolved, and writes once", async () => {
    mocks.getPricingEntries.mockResolvedValue({
      items: [
        entry("ingredient-flour", "All-Purpose Flour"),
        entry("ingredient-cream", "Creme Fraiche"),
      ],
    })
    const saved = {
      id: "recipe-1",
      publicId: "rcp_0123456789ab",
      code: "R-001",
      editVersion: 1,
    }
    mocks.djangoAction.mockResolvedValue(saved)

    await expect(createPrimoRecipe(draft)).resolves.toEqual(saved)

    expect(mocks.getPricingEntries).toHaveBeenCalledTimes(1)
    expect(mocks.djangoAction).toHaveBeenCalledTimes(1)
    expect(mocks.djangoAction).toHaveBeenCalledWith("save-recipe", {
      id: null,
      title: "Cream biscuits",
      description: "A quick test recipe.",
      kind: "recipe",
      status: "active",
      body: "",
      method: "",
      yieldAmount: 12,
      yieldUnit: "slice",
      items: [
        {
          kind: "ingredient",
          displayName: "all purpose flour",
          quantity: 250,
          unit: "g",
          preparationNote: "sifted",
          efficiency: 100,
          efficiencyAfterCooking: 100,
          isBase: false,
          excludedFromCost: false,
          ingredientId: "ingredient-flour",
          subrecipeId: null,
        },
        {
          kind: "ingredient",
          displayName: "Flour",
          quantity: 1,
          unit: "cup",
          preparationNote: "",
          efficiency: 100,
          efficiencyAfterCooking: 100,
          isBase: false,
          excludedFromCost: false,
          ingredientId: null,
          subrecipeId: null,
        },
        {
          kind: "ingredient",
          displayName: "crème fraîche",
          quantity: null,
          unit: "",
          preparationNote: "to taste",
          efficiency: 100,
          efficiencyAfterCooking: 100,
          isBase: false,
          excludedFromCost: false,
          ingredientId: "ingredient-cream",
          subrecipeId: null,
        },
      ],
      steps: [
        {
          kind: "instruction",
          title: "",
          body: "Mix the dough.",
          laborKind: "",
          timings: [],
        },
        {
          kind: "instruction",
          title: "",
          body: "Bake until golden.",
          laborKind: "",
          timings: [],
        },
      ],
      batchSizes: [],
      equivalency: null,
    })
    expect(mocks.revalidatePath.mock.calls.map(([path]) => path)).toEqual([
      "/",
      "/recipes",
      "/products",
    ])
  })

  it("leaves a line unresolved when two active pantry names normalize alike", async () => {
    mocks.getPricingEntries.mockResolvedValue({
      items: [
        entry("ingredient-cream-1", "Creme Fraiche"),
        entry("ingredient-cream-2", "crème-fraîche"),
      ],
    })
    mocks.djangoAction.mockResolvedValue({
      id: "recipe-1",
      publicId: "rcp_0123456789ab",
      code: "R-001",
      editVersion: 1,
    })

    await createPrimoRecipe({
      ...draft,
      ingredients: [
        {
          name: "Crème Fraîche",
          quantity: 200,
          unit: "g",
          preparation: "",
        },
      ],
    })

    expect(mocks.djangoAction).toHaveBeenCalledTimes(1)
    expect(mocks.djangoAction).toHaveBeenCalledWith(
      "save-recipe",
      expect.objectContaining({
        items: [
          expect.objectContaining({
            displayName: "Crème Fraîche",
            ingredientId: null,
          }),
        ],
      })
    )
  })

  it("links neither a supply nor an archived pantry row", async () => {
    mocks.getPricingEntries.mockResolvedValue({
      items: [
        entry("supply-box", "Takeout box", { nonEdible: true }),
        entry("ingredient-old-flour", "Flour", { status: "archived" }),
      ],
    })
    mocks.djangoAction.mockResolvedValue({
      id: "recipe-1",
      publicId: "rcp_0123456789ab",
      code: "R-001",
      editVersion: 1,
    })

    await createPrimoRecipe({
      ...draft,
      ingredients: [
        { name: "Takeout box", quantity: 1, unit: "each", preparation: "" },
        { name: "Flour", quantity: 250, unit: "g", preparation: "" },
      ],
    })

    expect(mocks.djangoAction).toHaveBeenCalledWith(
      "save-recipe",
      expect.objectContaining({
        items: [
          expect.objectContaining({
            displayName: "Takeout box",
            ingredientId: null,
          }),
          expect.objectContaining({ displayName: "Flour", ingredientId: null }),
        ],
      })
    )
  })

  it("rejects malformed or identity-bearing drafts before any read or write", async () => {
    await expect(
      createPrimoRecipe({ ...draft, ingredients: [] })
    ).resolves.toEqual({ error: "That recipe draft is malformed." })
    await expect(
      createPrimoRecipe({
        ...draft,
        ingredients: [
          {
            ...draft.ingredients[0],
            ingredientId: "model-invented-id",
          },
        ],
      })
    ).resolves.toEqual({ error: "That recipe draft is malformed." })

    expect(mocks.getPricingEntries).not.toHaveBeenCalled()
    expect(mocks.djangoAction).not.toHaveBeenCalled()
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  it("returns a safe error and does not revalidate when the single write fails", async () => {
    mocks.getPricingEntries.mockResolvedValue({ items: [] })
    mocks.djangoAction.mockRejectedValue({ status: 500 })

    await expect(createPrimoRecipe(draft)).resolves.toEqual({
      error: "Couldn’t create the recipe.",
    })
    expect(mocks.djangoAction).toHaveBeenCalledTimes(1)
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})
