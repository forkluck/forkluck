import { describe, expect, it } from "vitest"
import { recipeDraftSchema, reviseRecipeDraft } from "@/lib/recipe/draft"
const draft = recipeDraftSchema.parse({
  title: "Synthetic cookies",
  description: "Source: Synthetic.txt, Page 1. Check oven temperature.",
  yield: { amount: 24, unit: "pcs" },
  ingredients: [
    { name: "Flour", quantity: 300, unit: "g", preparation: "sifted" },
    { name: "Butter", quantity: 200, unit: "g", preparation: "softened" },
    { name: "Sugar", quantity: 100, unit: "g", preparation: "" },
    { name: "Salt", quantity: 2, unit: "g", preparation: "check amount" },
    { name: "Vanilla", quantity: null, unit: "", preparation: "to taste" },
  ],
  steps: [
    "Cream butter and sugar.",
    "Mix in flour.",
    "Stir in salt.",
    "Bake at 175 C for 12 minutes.",
  ],
})
describe("recipe draft revisions", () => {
  it.each([{ multiplier: 0.5 }, { yieldAmount: 12 }])(
    "scales only measured quantities with %j",
    (revision) => {
      const result = reviseRecipeDraft(draft, revision)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.message)
      expect(result.draft.yield?.amount).toBe(12)
      expect(result.draft.ingredients.map((line) => line.quantity)).toEqual([
        150,
        100,
        50,
        1,
        null,
      ])
      expect(result.draft.steps).toEqual(draft.steps)
      expect(result.draft.description).toBe(draft.description)
      expect(result.draft.ingredients.map((line) => line.preparation)).toEqual(
        draft.ingredients.map((line) => line.preparation)
      )
      expect(draft.yield?.amount).toBe(24)
    }
  )
  it("changes exactly one field without clearing defaulted notes or steps", () => {
    const result = reviseRecipeDraft(draft, {
      ingredientChanges: [{ index: 3, quantity: 1.5 }],
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.draft).toEqual({
      ...draft,
      ingredients: draft.ingredients.map((line, index) =>
        index === 3 ? { ...line, quantity: 1.5 } : line
      ),
    })
  })
  it("supports an explicit method change and clearing a description", () => {
    const result = reviseRecipeDraft(draft, {
      description: "",
      steps: ["The requested replacement method."],
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.draft.description).toBe("")
    expect(result.draft.steps).toEqual(["The requested replacement method."])
    expect(result.draft.ingredients).toEqual(draft.ingredients)
  })
  it.each([
    { multiplier: 0.5, yieldAmount: 12 },
    { multiplier: 0 },
    {
      multiplier: 1000,
      ingredientChanges: [{ index: 0, quantity: 1_000_001 }],
    },
    { ingredientChanges: [{ index: 99, quantity: 1 }] },
    {
      ingredientChanges: [
        { index: 0, quantity: 1 },
        { index: 0, quantity: 2 },
      ],
    },
  ])("rejects conflicting or out-of-range revisions %j", (revision) => {
    expect(reviseRecipeDraft(draft, revision).ok).toBe(false)
  })
  it("requires a known yield for a target, while a multiplier preserves an unknown yield", () => {
    expect(
      reviseRecipeDraft({ ...draft, yield: null }, { yieldAmount: 12 }).ok
    ).toBe(false)
    const result = reviseRecipeDraft(
      { ...draft, yield: null },
      { multiplier: 2 }
    )
    if (!result.ok) throw new Error(result.message)
    expect(result.draft.yield).toBeNull()
    expect(result.draft.ingredients[0]!.quantity).toBe(600)
  })
})
