import { z } from "zod"

import { UNIT_CATALOG, YIELD_UNIT_VALUES } from "@/lib/unit-registry"

const recipeLineUnits = UNIT_CATALOG.map((unit) => unit.slug) as [
  string,
  ...string[],
]

export const recipeDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).default(""),
  yield: z
    .strictObject({
      amount: z.number().positive().max(1_000_000),
      unit: z.enum(YIELD_UNIT_VALUES),
    })
    .nullable()
    .default(null)
    .describe(
      'Recipe yield as an object, e.g. {"amount": 10, "unit": "pcs"} for 10 servings or {"amount": 4, "unit": "qt"} for 4 quarts. Never a string. Null only when unstated.'
    ),
  ingredients: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        quantity: z.number().positive().max(1_000_000).nullable(),
        unit: z.union([z.enum(recipeLineUnits), z.literal("")]),
        preparation: z.string().trim().max(200).default(""),
      })
    )
    .min(1)
    .max(100),
  steps: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
})

export type RecipeDraft = z.infer<typeof recipeDraftSchema>

export const recipeDraftRevisionSchema = z.strictObject({
  multiplier: z
    .number()
    .finite()
    .positive()
    .max(1000)
    .optional()
    .describe(
      "Scale yield and all measured quantities; keep the method and notes unchanged."
    ),
  yieldAmount: z
    .number()
    .finite()
    .positive()
    .max(1_000_000)
    .optional()
    .describe(
      "Alternatively scale to this yield amount in the draft's existing yield unit."
    ),
  title: recipeDraftSchema.shape.title.optional(),
  description: recipeDraftSchema.shape.description.removeDefault().optional(),
  ingredientChanges: z
    .array(
      recipeDraftSchema.shape.ingredients.element.partial().extend({
        preparation:
          recipeDraftSchema.shape.ingredients.element.shape.preparation
            .removeDefault()
            .optional(),
        index: z
          .number()
          .int()
          .min(0)
          .max(99)
          .describe("Zero-based ingredient line index from read_recipe_draft."),
      })
    )
    .max(100)
    .optional(),
  steps: recipeDraftSchema.shape.steps.removeDefault().optional(),
})
export type RecipeDraftRevision = z.infer<typeof recipeDraftRevisionSchema>

/** Apply a requested patch; unchanged recipe text never passes through a model. */
export function reviseRecipeDraft(
  draft: RecipeDraft,
  raw: RecipeDraftRevision
) {
  const parsed = recipeDraftRevisionSchema.safeParse(raw)
  const fail = (message: string) => ({ ok: false as const, message })
  if (!parsed.success) return fail("That recipe revision is not valid.")
  const revision = parsed.data
  if (revision.multiplier !== undefined && revision.yieldAmount !== undefined)
    return fail("Choose a multiplier or a target yield, not both.")
  if (revision.yieldAmount !== undefined && !draft.yield)
    return fail("This draft has no measured yield. Give a multiplier instead.")
  const multiplier =
    revision.multiplier ??
    (revision.yieldAmount !== undefined && draft.yield
      ? revision.yieldAmount / draft.yield.amount
      : 1)
  const indexes = revision.ingredientChanges?.map((line) => line.index) ?? []
  if (
    new Set(indexes).size !== indexes.length ||
    indexes.some((index) => index >= draft.ingredients.length)
  )
    return fail("Choose each ingredient line once from the current draft.")
  const patches = new Map(
    revision.ingredientChanges?.map(({ index, ...patch }) => [index, patch])
  )
  const next = recipeDraftSchema.safeParse({
    ...draft,
    ...(revision.title !== undefined ? { title: revision.title } : {}),
    ...(revision.description !== undefined
      ? { description: revision.description }
      : {}),
    ...(revision.steps !== undefined ? { steps: revision.steps } : {}),
    yield: draft.yield
      ? {
          ...draft.yield,
          amount: Number((draft.yield.amount * multiplier).toPrecision(12)),
        }
      : null,
    ingredients: draft.ingredients.map((line, index) => ({
      ...line,
      quantity:
        line.quantity === null
          ? null
          : Number((line.quantity * multiplier).toPrecision(12)),
      ...patches.get(index),
    })),
  })
  if (!next.success)
    return fail(
      "That revision exceeds the recipe limits. Use a smaller batch or check the quantities."
    )
  const changes = [
    ...(multiplier !== 1
      ? [
          `Scaled yield and measured ingredients by ${Number(multiplier.toPrecision(8))}×.`,
        ]
      : []),
    ...(revision.title !== undefined ? ["Updated title."] : []),
    ...(revision.description !== undefined ? ["Updated description."] : []),
    ...indexes.map(
      (index) =>
        `Updated ingredient ${index + 1}: ${next.data.ingredients[index]!.name}.`
    ),
    revision.steps === undefined
      ? "Method preserved exactly."
      : "Updated method.",
  ]
  return { ok: true as const, draft: next.data, changes }
}
