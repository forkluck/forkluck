"use client"

import * as React from "react"

import { requestCustomNutrition } from "@/app/(app)/ingredients/actions"
import {
  CUSTOM_NUTRITION_FIELDS,
  type CustomNutritionValueKey,
  type CustomNutritionValues,
} from "@/lib/nutrition/custom-values"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldDescription, FieldError } from "@/components/ui/field"
import { Input, InputAffix, InputGroup } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toast"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure } from "@/lib/save-failure"

const EMPTY_VALUES = Object.fromEntries(
  CUSTOM_NUTRITION_FIELDS.map((field) => [field.key, ""])
) as Record<CustomNutritionValueKey, string>

const SERVING_FIELD = "custom-nutrition-serving"

const fieldId = (key: CustomNutritionValueKey) => `custom-nutrition-${key}`

const parseAmount = (text: string): number | null => {
  if (text.trim() === "") return null
  const value = Number.parseFloat(text)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Package values for an ingredient no USDA record matches. The request is a
 * row support applies; the ingredient reads "Custom" once they have.
 */
export function RequestCustomNutritionDialog({
  ingredientId,
  ingredientName,
  open,
  onOpenChange,
  onSent,
}: {
  ingredientId: string
  ingredientName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent?: () => void
}) {
  const toast = useToast()
  const [servingGrams, setServingGrams] = React.useState("100")
  const [values, setValues] = React.useState(EMPTY_VALUES)
  const [source, setSource] = React.useState("")
  const [note, setNote] = React.useState("")

  const form = useFormSave({
    snapshot: JSON.stringify([servingGrams, values, source, note]),
    validate: (): FormErrors => {
      const grams = parseAmount(servingGrams)
      if (grams === null || grams <= 0) {
        return {
          [SERVING_FIELD]: "Enter the amount in grams these values describe.",
        }
      }
      for (const field of CUSTOM_NUTRITION_FIELDS) {
        const amount = parseAmount(values[field.key])
        if (amount === null && values[field.key].trim() !== "") {
          return {
            [fieldId(field.key)]:
              `${field.label} has to be a number, 0 or more.`,
          }
        }
        if (field.required && amount === null) {
          return { [fieldId(field.key)]: `${field.label} is required.` }
        }
      }
      return {}
    },
    save: async () => {
      const parsed = Object.fromEntries(
        CUSTOM_NUTRITION_FIELDS.map((field) => [
          field.key,
          parseAmount(values[field.key]),
        ])
      ) as CustomNutritionValues
      const result = await requestCustomNutrition(ingredientId, {
        servingGrams: parseAmount(servingGrams)!,
        values: parsed,
        source: source.trim() || undefined,
        note: note.trim() || undefined,
      })
      return "error" in result ? toSaveFailure(result) : null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  const submit = () =>
    void form.submit().then((done) => {
      if (!done) return
      toast.add({ title: "Request sent" })
      onSent?.()
      onOpenChange(false)
    })

  const dismiss = () => confirm(form.dirty, () => onOpenChange(false))
  const [firstError] = Object.values(form.errors)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent size="md" onKeyDown={dialogSaveShortcut(submit)}>
        <DialogHeader>
          <DialogTitle>Request a custom value</DialogTitle>
          <DialogDescription>
            Enter what the package or spec sheet says and we add it as a custom
            source for {ingredientName}. Leave a line blank if the package does
            not show it.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="custom-nutrition-source">
              Source
              <span className="font-normal text-faint">optional</span>
            </Label>
            <Input
              id="custom-nutrition-source"
              value={source}
              maxLength={240}
              onChange={(event) => setSource(event.target.value)}
              placeholder="American Almond Almond Paste, 7 LB"
            />
            <FieldDescription>
              What the values were read off. This becomes the name beside the
              Custom badge, so a later reader knows where the numbers came from.
            </FieldDescription>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={SERVING_FIELD}>
              Amount these values describe (g)
            </Label>
            <InputGroup className="w-40">
              <Input
                id={SERVING_FIELD}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={servingGrams}
                onChange={(event) => setServingGrams(event.target.value)}
                className="pr-8 tabular-nums"
              />
              <InputAffix side="end">g</InputAffix>
            </InputGroup>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {CUSTOM_NUTRITION_FIELDS.map((field) => (
              <div key={field.key} className="flex flex-col gap-2">
                <Label htmlFor={fieldId(field.key)}>
                  {field.label}
                  {field.required ? null : (
                    <span className="font-normal text-faint">optional</span>
                  )}
                </Label>
                <InputGroup>
                  <Input
                    id={fieldId(field.key)}
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={values[field.key]}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))
                    }
                    className="pr-12 tabular-nums"
                  />
                  <InputAffix side="end">{field.unit}</InputAffix>
                </InputGroup>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="custom-nutrition-note">
              Note
              <span className="font-normal text-faint">optional</span>
            </Label>
            <Textarea
              id="custom-nutrition-note"
              value={note}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Spec sheet number, a date, anything else that helps us check it"
            />
          </div>
          {(firstError ?? form.failure) ? (
            <FieldError>{firstError ?? form.failure?.message}</FieldError>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" pending={form.pending}>
              Send request
            </Button>
          </DialogFooter>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
