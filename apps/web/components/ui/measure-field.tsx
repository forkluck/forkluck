"use client"

import { UnitCombobox } from "@/components/ingredients/unit-combobox"
import type { UnitOption } from "@/lib/unit-registry"
import { cn } from "@/lib/utils"

/**
 * An amount with its unit as a chip inside the same field: "250 [g ▾]".
 * The shape every measured value in the app takes.
 */
export function MeasureField({
  id,
  label,
  unitLabel,
  placeholder = "–",
  amount,
  unit,
  options,
  disabled = false,
  invalid = false,
  amountDisabled = false,
  amountReadOnly = false,
  className,
  onAmountChange,
  onAmountKeyDown,
  onUnitChange,
  onBlur,
}: {
  id?: string
  label: string
  /** What the unit picker is called, where it names something wider than the
   *  amount beside it: a "Size" amount whose picker is the purchase unit. */
  unitLabel?: string
  placeholder?: string
  amount: string
  unit: string | null
  options: UnitOption[]
  disabled?: boolean
  /** Marks the pair when the form rejects it (an amount with no unit, or the reverse). */
  invalid?: boolean
  /** Locks the number while the unit stays free, for an amount the app computes. */
  amountDisabled?: boolean
  /** Shown but not yet accepting input, with no disabled styling. */
  amountReadOnly?: boolean
  className?: string
  onAmountChange: (amount: string) => void
  onAmountKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
  onUnitChange: (unit: string | null) => void
  onBlur?: () => void
}) {
  return (
    <div
      className={cn(
        "grid h-9 grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-md border border-input bg-card focus-within:border-foreground",
        invalid && "border-destructive",
        className
      )}
    >
      <input
        id={id}
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        value={amount}
        placeholder={placeholder}
        disabled={disabled || amountDisabled}
        readOnly={amountReadOnly}
        aria-label={`${label} amount`}
        onChange={(event) => onAmountChange(event.target.value)}
        onKeyDown={onAmountKeyDown}
        onBlur={onBlur}
        className="min-w-0 bg-transparent px-3 text-md tabular-nums outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:text-faint [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <UnitCombobox
        label={unitLabel ?? label}
        value={unit}
        onChange={onUnitChange}
        options={options}
        disabled={disabled}
        invalid={invalid}
        variant="chip"
        className="mr-1"
        popupClassName="w-[205px]"
      />
    </div>
  )
}
