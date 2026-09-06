"use client"

import * as React from "react"

import {
  useIngredientEdit,
  useIngredientTabSave,
} from "@/components/ingredients/ingredient-chrome"
import { IngredientNutritionFields } from "@/components/nutrition/ingredient-nutrition-fields"
import { NutritionLabelCard } from "@/components/nutrition/nutrition-label"
import { Input, InputAffix, InputGroup } from "@/components/ui/input"
import type { IngredientDetail } from "@/lib/backend/types"
import { useRefresh } from "@/hooks/use-refresh"
import {
  missingNutrients,
  nutrientsFromComposition,
  scaleNutrients,
} from "@/lib/nutrition/label"

/** The ingredient's Nutrition tab: its data, then a label built from it alone. */
export function IngredientNutritionPanel({
  ingredient,
}: {
  ingredient: IngredientDetail
}) {
  const { refresh } = useRefresh()
  const { saveRef, setDirty, setSaveState } = useIngredientEdit()
  useIngredientTabSave()
  const [servingGrams, setServingGrams] = React.useState("100")
  const grams = Number.parseFloat(servingGrams)
  const servingKnown = Number.isFinite(grams) && grams > 0

  const per100g = React.useMemo(
    () =>
      ingredient.nutrition
        ? nutrientsFromComposition(ingredient.nutrition.per100g, {
            sugarsAreAdded: ingredient.sugarsAreAdded,
          })
        : null,
    [ingredient.nutrition, ingredient.sugarsAreAdded]
  )
  const perServing =
    per100g && servingKnown ? scaleNutrients(per100g, grams / 100) : null
  const readiness = React.useMemo(() => {
    if (!per100g) return null
    const us = missingNutrients(per100g, "us")
    const eu = missingNutrients(per100g, "eu")
    return {
      us: { missing: us, ready: us.length === 0 },
      eu: { missing: eu, ready: eu.length === 0 },
    }
  }, [per100g])
  const allergens = {
    contains: ingredient.effectiveAllergens
      .filter((entry) => entry.status === "contains")
      .map((entry) => entry.key),
    mayContain: ingredient.effectiveAllergens
      .filter((entry) => entry.status === "mayContain")
      .map((entry) => entry.key),
  }

  return (
    <div className="min-w-0">
      <section className="max-w-[640px] print:hidden">
        <IngredientNutritionFields
          ingredient={ingredient}
          saveRef={saveRef}
          onDirtyChange={setDirty}
          onSaveState={setSaveState}
          onSaved={() => refresh()}
        />
      </section>
      <hr className="mt-8 h-1.5 w-full max-w-[640px] rounded-sm border-0 bg-secondary print:hidden" />
      <section className="mt-6 max-w-[640px]">
        <div className="flex min-h-8 items-center justify-between gap-3 print:hidden">
          <h2 className="text-lg font-semibold">Preview</h2>
          {per100g ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Serving (g)
              <InputGroup className="w-24">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  aria-label="Serving (g)"
                  value={servingGrams}
                  onChange={(event) => setServingGrams(event.target.value)}
                  className="h-8 pr-7 tabular-nums md:text-sm"
                />
                <InputAffix side="end">g</InputAffix>
              </InputGroup>
            </label>
          ) : null}
        </div>
        {per100g && readiness ? (
          <NutritionLabelCard
            className="mt-3 lg:max-w-[360px]"
            serving={{
              amount: servingKnown ? grams : null,
              unit: "g",
              grams: servingKnown ? grams : null,
            }}
            servings={null}
            perServing={perServing}
            per100g={per100g}
            statement={[
              {
                name: ingredient.nutritionLabelName || ingredient.name,
                grams: 100,
                allergens: allergens.contains,
              },
            ]}
            allergens={allergens}
            readiness={readiness}
            blockers={[]}
            servingBlockers={
              servingKnown ? [] : ["Enter a serving in grams to see it."]
            }
          />
        ) : (
          <p className="mt-3 text-base text-muted-foreground">
            Link nutrition data to see a preview.
          </p>
        )}
      </section>
    </div>
  )
}
