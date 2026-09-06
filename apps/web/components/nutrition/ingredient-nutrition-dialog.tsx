"use client"

import * as React from "react"

import { loadIngredientDetail } from "@/app/(app)/ingredients/actions"
import { IngredientNutritionFields } from "@/components/nutrition/ingredient-nutrition-fields"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldError } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import type { IngredientDetail } from "@/lib/backend/types"

/**
 * The ingredient's nutrition fields, opened from a recipe line. Loads the
 * pantry row on open; every field saves itself, so Done only closes.
 */
export function IngredientNutritionDialog({
  publicId,
  open,
  onOpenChange,
  onSaved,
}: {
  publicId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** After any field saves, so the recipe can refetch its rollup. */
  onSaved?: () => void
}) {
  const [ingredient, setIngredient] = React.useState<IngredientDetail | null>(
    null
  )
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    void loadIngredientDetail(publicId).then((result) => {
      if (cancelled) return
      if ("error" in result) setError(result.error)
      else setIngredient(result)
    })
    return () => {
      cancelled = true
    }
  }, [open, publicId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Update ingredient nutrition</DialogTitle>
          {ingredient ? (
            <DialogDescription>
              Changes here apply to {ingredient.name} in every recipe that uses
              it.
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {ingredient ? (
          <IngredientNutritionFields
            ingredient={ingredient}
            onSaved={onSaved}
          />
        ) : error ? (
          <FieldError>{error}</FieldError>
        ) : (
          <div className="flex h-24 items-center justify-center">
            <Spinner label="Loading ingredient" />
          </div>
        )}
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
