"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { splitRecipeDocument } from "@/lib/recipe/split-document"

function Hints() {
  return (
    <p className="text-xs leading-5 text-muted-foreground">
      <span className="font-medium text-foreground"># Heading</span> starts a
      section · <span className="font-medium text-foreground">&gt; Note</span>{" "}
      adds a note
    </p>
  )
}

/**
 * Paste a recipe: the ingredient list becomes rows the way the quick-add
 * reads one line, the method becomes steps. What the pantry knows links on
 * the spot; the rest is resolved in the table.
 */
export type ImportPart = "recipe" | "ingredients" | "method"

export function ImportRecipeDialog({
  open,
  part,
  onOpenChange,
  onApply,
}: {
  open: boolean
  /** The whole recipe, or one list when opened from under a table. */
  part: ImportPart
  onOpenChange: (open: boolean) => void
  onApply: (ingredients: string, method: string) => void
}) {
  const wantIngredients = part !== "method"
  const wantMethod = part !== "ingredients"
  const [ingredients, setIngredients] = React.useState("")
  const [method, setMethod] = React.useState("")
  const [error, setError] = React.useState("")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size={part === "recipe" ? "lg" : "md"}>
        <DialogHeader>
          <DialogTitle>
            {part === "recipe"
              ? "Import recipe"
              : part === "ingredients"
                ? "Add ingredients"
                : "Add steps"}
          </DialogTitle>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-base text-destructive">
            {error}
          </p>
        ) : null}
        <div
          className={
            part === "recipe" ? "grid gap-5 sm:grid-cols-2" : "grid gap-5"
          }
        >
          {wantIngredients ? (
            <div className="grid gap-2">
              <label
                htmlFor="import-ingredients"
                className="text-sm font-medium"
              >
                Ingredients
              </label>
              <Textarea
                id="import-ingredients"
                autoFocus
                className="min-h-64 bg-card"
                value={ingredients}
                placeholder={
                  "# Dry mix\n500 g bread flour\n10 g salt\n\n# Wet\n3 egg yolks\n> room temperature"
                }
                onChange={(event) => setIngredients(event.target.value)}
                onPaste={(event) => {
                  // A cook copies the whole page, so a paste that carries the
                  // method as well drops it in the box beside this one, where
                  // it can be read and edited before it becomes steps.
                  if (!wantMethod || method.trim()) return
                  const field = event.currentTarget
                  const pasted = event.clipboardData.getData("text")
                  const whole =
                    ingredients.slice(0, field.selectionStart) +
                    pasted +
                    ingredients.slice(field.selectionEnd)
                  const split = splitRecipeDocument(whole)
                  if (!split.method) return
                  event.preventDefault()
                  setIngredients(split.ingredients)
                  setMethod(split.method)
                }}
              />
              <Hints />
            </div>
          ) : null}
          {wantMethod ? (
            <div className="grid gap-2">
              <label htmlFor="import-method" className="text-sm font-medium">
                Prep method
              </label>
              <Textarea
                id="import-method"
                autoFocus={!wantIngredients}
                className="min-h-64 bg-card"
                value={method}
                placeholder={
                  "# Dry mix\nHeat the oven to 175 °C.\nCombine the dry ingredients.\n> Rest overnight."
                }
                onChange={(event) => setMethod(event.target.value)}
              />
              <Hints />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (!ingredients.trim() && !method.trim()) {
                setError("Paste ingredients or a method first.")
                return
              }
              setError("")
              onApply(
                wantIngredients ? ingredients : "",
                wantMethod ? method : ""
              )
              setIngredients("")
              setMethod("")
              onOpenChange(false)
            }}
          >
            {part === "recipe" ? "Import" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
