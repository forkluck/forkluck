"use client"

import * as React from "react"

import type { BatchSize } from "@/components/recipes/recipe-chrome"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { MeasureField } from "@/components/ui/measure-field"
import {
  clampScaleFactor,
  formatScaleFactor,
  formatKitchenAmount,
} from "@/lib/recipe"
import {
  convertAmount,
  countedAsEach,
  unitDefinition,
  yieldUnitOptions,
} from "@/lib/unit-registry"

/** The units an amount can be typed in: the yield units of the yield's family. */
function amountOptions(yieldUnit: string | null) {
  const options = yieldUnitOptions()
  // A batch counted in pieces or in slices is typed in that same count.
  if (!yieldUnit || countedAsEach(yieldUnit) === "each") {
    return options.filter((unit) => countedAsEach(unit.slug) === "each")
  }
  const family = unitDefinition(yieldUnit)?.family
  return options.filter((unit) => unitDefinition(unit.slug)?.family === family)
}

/**
 * A batch arrived at by arithmetic: a multiple, or an amount to make — which
 * divides by the recipe's total yield. Either way the result is a batch size
 * the view can take, and the editor can keep it.
 */
export function CustomBatchDialog({
  open,
  onOpenChange,
  recipeYield,
  onApply,
  onRewrite,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  recipeYield: { amount: number; unit: string } | null
  /** View the recipe at this batch. */
  onApply: (batch: BatchSize) => void
  /** Rewrite the recipe at this factor; absent where it cannot be edited. */
  onRewrite?: (factor: number) => void
}) {
  const [multiple, setMultiple] = React.useState("")
  const [amount, setAmount] = React.useState("")
  const [unit, setUnit] = React.useState<string | null>(
    recipeYield?.unit ?? null
  )
  const [error, setError] = React.useState("")
  const count = countedAsEach(recipeYield?.unit ?? null) === "each"
  const yieldUnit = recipeYield?.unit ?? null
  // The yield's unit is the natural one to type in; follow it when it changes.
  const [seenYieldUnit, setSeenYieldUnit] = React.useState(yieldUnit)
  if (seenYieldUnit !== yieldUnit) {
    setSeenYieldUnit(yieldUnit)
    setUnit(yieldUnit)
  }

  const reset = () => {
    setMultiple("")
    setAmount("")
    onOpenChange(false)
  }

  const fromAmount = (() => {
    if (!recipeYield || !amount || !unit) return null
    const target = count
      ? Number(amount)
      : convertAmount(Number(amount), unit, recipeYield.unit)
    return target === null
      ? null
      : clampScaleFactor(target / recipeYield.amount)
  })()
  const fromMultiple = multiple ? clampScaleFactor(Number(multiple)) : null
  const factor = amount ? fromAmount : fromMultiple
  const label = amount
    ? `${formatKitchenAmount(Number(amount))} ${unit} (${formatScaleFactor(factor ?? 0)}x)`
    : `${formatScaleFactor(factor ?? 0)}x`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Custom batch</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-2 text-sm font-medium">
            Multiply by
            <Input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              className="w-32 tabular-nums"
              placeholder="7"
              value={multiple}
              onChange={(event) => {
                setMultiple(event.target.value)
                setAmount("")
              }}
            />
          </label>
          <div className="grid gap-2 text-sm font-medium">
            <span>
              Or make
              {recipeYield ? (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  (the recipe makes {formatKitchenAmount(recipeYield.amount)}{" "}
                  {recipeYield.unit})
                </span>
              ) : null}
            </span>
            <MeasureField
              label="Make"
              className="w-56"
              amount={amount}
              unit={unit}
              options={amountOptions(recipeYield?.unit ?? null)}
              disabled={!recipeYield}
              onAmountChange={(next) => {
                setAmount(next)
                setMultiple("")
              }}
              onUnitChange={setUnit}
            />
            {!recipeYield ? (
              <span className="font-normal text-muted-foreground">
                Set a total yield to scale by amount.
              </span>
            ) : null}
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-base text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {onRewrite ? (
            <Button
              type="button"
              variant="outline"
              disabled={factor === 1}
              onClick={() => {
                if (!factor) {
                  setError("Enter a multiplier or a target amount.")
                  return
                }
                setError("")
                onRewrite(factor)
                reset()
              }}
            >
              Rewrite recipe
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => {
              if (!factor) {
                setError("Enter a multiplier or a target amount.")
                return
              }
              setError("")
              onApply({ label, scale: factor, isOriginal: false })
              reset()
            }}
          >
            {factor ? `View at ${formatScaleFactor(factor)}x` : "View"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
