"use client"

import * as React from "react"
import { Check, ClipboardList, ExternalLink } from "lucide-react"

import { createPrimoRecipe } from "@/app/(app)/recipes/actions"
import { GuardedLink } from "@/components/navigation-blocker"
import { useRecipeLimitDialog } from "@/components/recipes/recipe-limit-dialog"
import { Button } from "@/components/ui/button"
import { useFormSave } from "@/hooks/use-form-save"
import type { PrimoRecipeDraft } from "@/lib/primo/recipe"
import { formatKitchenAmount } from "@/lib/recipe/scale"
import { toSaveFailure } from "@/lib/save-failure"
import { unitShort, unitWord } from "@/lib/unit-registry"

function yieldLabel(draftYield: NonNullable<PrimoRecipeDraft["yield"]>) {
  const unit =
    draftYield.unit === "pcs"
      ? draftYield.amount === 1
        ? "piece"
        : "pieces"
      : draftYield.unit === "slice"
        ? draftYield.amount === 1
          ? "slice"
          : "slices"
        : unitWord(draftYield.unit)
  return `${formatKitchenAmount(draftYield.amount)} ${unit}`
}

function ingredientMeasure(
  ingredient: PrimoRecipeDraft["ingredients"][number]
) {
  if (ingredient.quantity === null) return "Unmeasured"
  const unit = unitShort(ingredient.unit)
  return `${formatKitchenAmount(ingredient.quantity)}${unit ? ` ${unit}` : ""}`
}

export function PrimoRecipeDraftCard({ draft }: { draft: PrimoRecipeDraft }) {
  const [createdPublicId, setCreatedPublicId] = React.useState<string | null>(
    null
  )
  const recipeLimit = useRecipeLimitDialog()
  const form = useFormSave({
    snapshot: JSON.stringify(draft),
    saved: false,
    save: async () => {
      const result = await createPrimoRecipe(draft)
      if ("error" in result) {
        recipeLimit.show(result)
        return toSaveFailure(result)
      }
      setCreatedPublicId(result.publicId)
      return null
    },
  })

  return (
    <section className="w-full rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3.5">
        <div className="flex items-center gap-2 text-md leading-5 font-medium text-foreground">
          <ClipboardList className="size-3.5" aria-hidden="true" />
          <span>Recipe draft</span>
        </div>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
          Review this draft or ask Primo to change it before creating the
          recipe.
        </p>
      </div>

      <div className="px-4 py-4">
        <h3 className="font-heading text-xl leading-7 font-semibold tracking-tight text-foreground">
          {draft.title}
        </h3>
        {draft.description ? (
          <p className="mt-1 text-md leading-5 text-muted-foreground">
            {draft.description}
          </p>
        ) : null}
        {draft.yield ? (
          <p className="mt-3 text-xs leading-4 text-muted-foreground">
            <span className="font-medium text-foreground">Total yield:</span>{" "}
            {yieldLabel(draft.yield)}
          </p>
        ) : null}

        <div className="mt-4">
          <h4 className="text-xs leading-4 font-medium text-muted-foreground">
            Ingredients
          </h4>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {draft.ingredients.map((ingredient, index) => (
              <li
                key={`${ingredient.name}-${index}`}
                className="flex items-start gap-3 py-2.5 text-md leading-5"
              >
                <span className="w-20 shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">
                  {ingredientMeasure(ingredient)}
                </span>
                <span className="min-w-0 leading-5 text-foreground">
                  {ingredient.name}
                  {ingredient.preparation ? (
                    <span className="text-muted-foreground">
                      {", "}
                      {ingredient.preparation}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4">
          <h4 className="text-xs leading-4 font-medium text-muted-foreground">
            Method
          </h4>
          {draft.steps.length ? (
            <ol className="mt-2 space-y-2 text-md leading-5 text-foreground">
              {draft.steps.map((step, index) => (
                <li key={`${step}-${index}`} className="flex gap-2.5">
                  <span className="shrink-0 text-xs leading-4 text-muted-foreground tabular-nums">
                    {index + 1}.
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-md leading-5 text-muted-foreground">
              No method steps yet.
            </p>
          )}
        </div>

        {createdPublicId ? (
          <div className="mt-5 rounded-lg bg-success-fill px-3 py-3 text-success">
            <div
              role="status"
              className="flex items-center gap-2 text-md leading-5 font-medium"
            >
              <Check className="size-4" aria-hidden="true" />
              Recipe created
            </div>
            <Button
              render={
                <GuardedLink
                  href={`/recipes/${createdPublicId}/recipe`}
                  className="mt-2"
                />
              }
              size="sm"
              variant="outline"
            >
              Open recipe
              <ExternalLink data-icon="inline-end" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <div className="mt-5">
            {form.failure ? (
              <p role="alert" className="mb-2 text-xs text-destructive">
                {form.failure.message}
              </p>
            ) : null}
            <Button
              type="button"
              size="sm"
              pending={form.pending}
              onClick={() => void form.submit()}
            >
              Create recipe
            </Button>
          </div>
        )}
      </div>
      {recipeLimit.dialog}
    </section>
  )
}
