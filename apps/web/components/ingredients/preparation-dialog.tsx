"use client"

import * as React from "react"
import { Info } from "lucide-react"

import { UnitCombobox } from "@/components/ingredients/unit-combobox"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import type { SaveFailure } from "@/lib/save-failure"
import { conversionUnitOptions } from "@/lib/unit-registry"

/** What the save action takes; `null` values are a field left blank. */
export type PreparationInput = {
  id: string | null
  name: string
  yieldPercent: number | null
  usesStandardConversion: boolean
  weight: { amount: number; unit: string } | null
  volume: { amount: number; unit: string } | null
  each: { amount: number; unit: string } | null
}

const CONVERSION_UNITS = conversionUnitOptions()

const NAME_FIELD = "preparation-name"
const YIELD_FIELD = "preparation-yield"

const numberOrNull = (value: string) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function PreparationDialog({
  open,
  onOpenChange,
  onAdd,
  initial = null,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null once the preparation is written; the dialog shows any failure. */
  onAdd: (preparation: PreparationInput) => Promise<SaveFailure | null>
  /** The row being edited; absent means this is a new preparation. */
  initial?: PreparationInput | null
}) {
  const units = CONVERSION_UNITS
  const text = (value: number | null) => (value === null ? "" : String(value))
  const [name, setName] = React.useState(initial?.name ?? "")
  const [yieldPercent, setYieldPercent] = React.useState(
    text(initial?.yieldPercent ?? null)
  )
  const [weight, setWeight] = React.useState(
    text(initial?.weight?.amount ?? null)
  )
  const [weightUnit, setWeightUnit] = React.useState<string | null>(
    initial?.weight?.unit || null
  )
  const [volume, setVolume] = React.useState(
    text(initial?.volume?.amount ?? null)
  )
  const [volumeUnit, setVolumeUnit] = React.useState<string | null>(
    initial?.volume?.unit || null
  )
  const [each, setEach] = React.useState(text(initial?.each?.amount ?? null))
  const [eachUnit, setEachUnit] = React.useState<string | null>(
    initial?.each?.unit || null
  )
  const [usesStandardConversion, setUsesStandardConversion] = React.useState(
    initial?.usesStandardConversion ?? true
  )
  const measure = (
    amount: string,
    unit: string | null
  ): { amount: number; unit: string } | null =>
    unit && numberOrNull(amount) !== null && numberOrNull(amount)! > 0
      ? { amount: numberOrNull(amount)!, unit }
      : null

  const pairError = (label: string, amount: string, unit: string | null) => {
    const number = numberOrNull(amount)
    const amountBlank = amount.trim() === ""
    if (amountBlank && !unit) return null
    if (amountBlank || !unit || number === null || number <= 0) {
      return `${label} amount and unit must be supplied together and the amount must be greater than zero.`
    }
    return null
  }

  const form = useFormSave({
    snapshot: JSON.stringify([
      name,
      yieldPercent,
      weight,
      weightUnit,
      volume,
      volumeUnit,
      each,
      eachUnit,
      usesStandardConversion,
    ]),
    validate: (): FormErrors => {
      const errors: FormErrors = {}
      if (!name.trim()) errors[NAME_FIELD] = "Enter a name."
      if (yieldPercent.trim()) {
        const value = numberOrNull(yieldPercent)
        if (value === null || value <= 0 || value > 1000) {
          errors[YIELD_FIELD] =
            "Yield must be greater than zero and at most 1000."
        }
      }
      if (!usesStandardConversion) {
        for (const [label, id, amount, unit] of [
          ["Weight", "preparation-weight", weight, weightUnit],
          ["Volume", "preparation-volume", volume, volumeUnit],
          ["Each", "preparation-each", each, eachUnit],
        ] as const) {
          const error = pairError(label, amount, unit)
          if (error) errors[id] = error
        }
      }
      return errors
    },
    save: () =>
      onAdd({
        id: initial?.id ?? null,
        name: name.trim(),
        yieldPercent: numberOrNull(yieldPercent),
        usesStandardConversion,
        weight: usesStandardConversion ? null : measure(weight, weightUnit),
        volume: usesStandardConversion ? null : measure(volume, volumeUnit),
        each: usesStandardConversion ? null : measure(each, eachUnit),
      }),
  })
  const { confirm, dialog } = useDirtyDialog()

  const clearConversion = () => {
    setWeight("")
    setWeightUnit(null)
    setVolume("")
    setVolumeUnit(null)
    setEach("")
    setEachUnit(null)
  }

  const dismiss = () => confirm(form.dirty, () => onOpenChange(false))

  const rows = [
    [
      "Weight",
      "preparation-weight",
      weight,
      setWeight,
      weightUnit,
      setWeightUnit,
      units.weight,
    ],
    [
      "Volume",
      "preparation-volume",
      volume,
      setVolume,
      volumeUnit,
      setVolumeUnit,
      units.volume,
    ],
    [
      "Each",
      "preparation-each",
      each,
      setEach,
      eachUnit,
      setEachUnit,
      units.each,
    ],
  ] as const

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit preparation" : "Add preparation"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.submit().then((done) => {
              if (done) onOpenChange(false)
            })
          }}
        >
          <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <h3 className="text-lg font-semibold">UOM</h3>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Info
                      className="size-[14px] shrink-0 text-muted-foreground"
                      strokeWidth={1.8}
                      role="img"
                      aria-label="What the preparation UOM means"
                    />
                  }
                />
                <TooltipContent className="max-w-[280px]">
                  Standard uses the ingredient’s conversion. Turn it off only
                  when this preparation has measurements of its own.
                </TooltipContent>
              </Tooltip>
            </div>
            <label className="flex h-8 items-center gap-2.5 text-sm font-medium text-foreground">
              <Switch
                size="sm"
                checked={usesStandardConversion}
                onCheckedChange={(checked) => {
                  setUsesStandardConversion(checked)
                  if (checked) clearConversion()
                }}
              />
              Use ingredient&apos;s standard conversion
            </label>
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            Leave yield blank to use a reviewed catalog estimate when one is
            available.
          </p>

          <div className="mt-3 border-b border-border pb-3">
            <div className="hidden grid-cols-[1.35fr_.75fr_repeat(3,minmax(0,1fr))] gap-3 border-b border-line-strong pb-3 sm:grid">
              <span className="text-sm font-medium">Name (required)</span>
              <span className="text-sm font-medium">Yield</span>
              {rows.map(([label, id]) => (
                <span key={id} className="text-sm font-medium">
                  {label}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.35fr_.75fr_repeat(3,minmax(0,1fr))] sm:pt-2">
              <div className="min-w-0">
                <label
                  htmlFor={NAME_FIELD}
                  className="mb-2 block border-b border-line-strong pb-2 text-sm font-medium sm:sr-only"
                >
                  Name (required)
                </label>
                <input
                  id={NAME_FIELD}
                  autoFocus
                  value={name}
                  placeholder="Diced"
                  onChange={(event) => setName(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-card px-3 text-md outline-none placeholder:text-faint hover:border-line-strong focus:border-foreground"
                />
                {form.errors[NAME_FIELD] ? (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {form.errors[NAME_FIELD]}
                  </p>
                ) : null}
              </div>
              <div className="min-w-0">
                <label
                  htmlFor={YIELD_FIELD}
                  className="mb-2 block border-b border-line-strong pb-2 text-sm font-medium sm:sr-only"
                >
                  Yield
                </label>
                <div className="grid h-9 grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-md border border-input bg-card focus-within:border-foreground">
                  <input
                    id={YIELD_FIELD}
                    type="number"
                    min="0.001"
                    max="1000"
                    step="any"
                    inputMode="decimal"
                    value={yieldPercent}
                    placeholder="–"
                    aria-label="Yield percent"
                    onChange={(event) => setYieldPercent(event.target.value)}
                    className="min-w-0 bg-transparent px-2.5 text-md tabular-nums outline-none placeholder:text-faint [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <span className="mr-2 self-center text-2xs font-semibold text-muted-foreground">
                    %
                  </span>
                </div>
                {form.errors[YIELD_FIELD] ? (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {form.errors[YIELD_FIELD]}
                  </p>
                ) : null}
              </div>
              {rows.map(
                ([label, id, amount, setAmount, unit, setUnit, options]) => (
                  <div key={id} className="min-w-0">
                    <label
                      htmlFor={id}
                      className="mb-2 block border-b border-line-strong pb-2 text-sm font-medium sm:sr-only"
                    >
                      {label}
                    </label>
                    <div className="grid h-9 grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-md border border-input bg-card focus-within:border-foreground">
                      <input
                        id={id}
                        type="number"
                        min="0.000001"
                        step="any"
                        inputMode="decimal"
                        value={amount}
                        placeholder="–"
                        aria-label={`${label} amount`}
                        onChange={(event) => setAmount(event.target.value)}
                        disabled={usesStandardConversion}
                        className="min-w-0 bg-transparent px-2.5 text-md tabular-nums outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:text-faint [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      <UnitCombobox
                        label={label}
                        value={unit}
                        onChange={setUnit}
                        disabled={usesStandardConversion}
                        options={options}
                        variant="chip"
                        className="mr-1"
                        popupClassName="w-[205px]"
                      />
                    </div>
                    {form.errors[id] ? (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {form.errors[id]}
                      </p>
                    ) : null}
                  </div>
                )
              )}
            </div>
          </div>

          {form.failure ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {form.failure.message}
            </p>
          ) : null}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" pending={form.pending}>
              {initial ? "Save preparation" : "Add preparation"}
            </Button>
          </DialogFooter>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
