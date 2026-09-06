"use client"

import * as React from "react"

import { MeasureField } from "@/components/ui/measure-field"
import type { UnitOption } from "@/lib/unit-registry"
import { cn } from "@/lib/utils"

export type UnitConversionField = { amount: string; unit: string | null }

export type UnitConversionValues = {
  weight: UnitConversionField
  volume: UnitConversionField
  each: UnitConversionField
}

const ROWS = [
  ["Weight", "weight"],
  ["Volume", "volume"],
  ["Each", "each"],
] as const

/**
 * One thing measured three ways — the grid an ingredient's unit conversion and
 * a recipe's equivalency both show. Presentation only: the screen around it
 * decides when the values are written down, since the ingredient saves on blur
 * while the recipe waits for its Save button.
 */
export function UnitConversionFields({
  idPrefix,
  values,
  options,
  disabled = false,
  locked = {},
  onChange,
  onCommit,
  actions,
}: {
  /** Keeps the field ids unique when two grids share a page. */
  idPrefix: string
  values: UnitConversionValues
  options: Record<keyof UnitConversionValues, UnitOption[]>
  disabled?: boolean
  /** A value supplied by the surrounding screen, such as a recipe's yield. */
  locked?: Partial<Record<keyof UnitConversionValues, boolean>>
  onChange: (next: UnitConversionValues) => void
  /** Called when a row is finished — on blur, or as soon as a unit is picked. */
  onCommit?: (next: UnitConversionValues) => void
  /** The trailing 32px column. Left out entirely when there is nothing to put there. */
  actions?: React.ReactNode
}) {
  const columns = actions
    ? "sm:grid-cols-[repeat(3,minmax(0,1fr))_32px]"
    : "sm:grid-cols-[repeat(3,minmax(0,1fr))]"

  return (
    <div className="border-b border-border pb-3">
      <div
        className={cn(
          "hidden gap-3 border-b border-line-strong pb-3 sm:grid",
          columns
        )}
      >
        {ROWS.map(([label, key]) => (
          <span key={key} className="text-sm font-medium">
            {label}
          </span>
        ))}
        {actions ? <span aria-hidden="true" /> : null}
      </div>
      <div className={cn("grid grid-cols-1 gap-3 sm:pt-2.5", columns)}>
        {ROWS.map(([label, key]) => {
          const field = values[key]
          return (
            // `relative` contains the sr-only label; loose, it stretches the page.
            <div key={key} className="relative min-w-0">
              <label
                htmlFor={`${idPrefix}-${key}`}
                className="mb-2 block border-b border-line-strong pb-2 text-sm font-medium sm:sr-only"
              >
                {label}
              </label>
              <MeasureField
                id={`${idPrefix}-${key}`}
                label={label}
                amount={field.amount}
                unit={field.unit}
                options={options[key]}
                disabled={disabled || locked[key]}
                onAmountChange={(amount) =>
                  onChange({ ...values, [key]: { ...field, amount } })
                }
                onBlur={() => {
                  const complete = field.amount === "" || field.unit
                  if (complete) onCommit?.(values)
                }}
                onUnitChange={(unit) => {
                  const next = { ...values, [key]: { ...field, unit } }
                  onChange(next)
                  if (field.amount !== "" && unit) onCommit?.(next)
                }}
              />
            </div>
          )
        })}
        {actions ? (
          <div className="flex h-9 items-center justify-end">{actions}</div>
        ) : null}
      </div>
    </div>
  )
}
