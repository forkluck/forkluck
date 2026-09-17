"use client"

import * as React from "react"
import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"

import { cn } from "@/lib/utils"
import { FieldLabel } from "@/components/ui/field"

/**
 * One choice out of a short, visible list: the costing basis, the unit system,
 * the export shape. Longer lists belong in a `Select`.
 *
 * The circle is 16px, a hair over the 15px `Checkbox` box so the round shape
 * reads as the same size beside it, on the same `--input` hairline every field
 * carries. Checked is an ink dot on an ink edge, never the accent: selection
 * is ink here and blue stays with data. No focus ring, so focus turns the edge
 * ink the way it does on every other control, and disabled keeps the shape but
 * drops the line to `--border` on the grey fill.
 *
 * The label sits beside the circle, not around it, and is wired by `htmlFor`,
 * so the text is part of the hit area without the row turning into the
 * selectable card `FieldLabel` draws when it wraps a whole field.
 */
function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("flex flex-col gap-3", className)}
      {...props}
    />
  )
}

function RadioItem({
  className,
  children,
  id,
  value,
  disabled,
  ...props
}: RadioPrimitive.Root.Props & { children?: React.ReactNode }) {
  const generatedId = React.useId()
  const itemId = id ?? generatedId

  return (
    <div
      data-slot="radio-item"
      data-disabled={disabled || undefined}
      className={cn("flex items-center gap-2", className)}
    >
      <RadioPrimitive.Root
        data-slot="radio"
        id={itemId}
        value={value}
        disabled={disabled}
        className="peer relative flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-card outline-none after:absolute after:-inset-x-2 after:-inset-y-2 focus-visible:border-foreground aria-invalid:border-destructive data-checked:border-foreground data-disabled:cursor-not-allowed data-disabled:border-border data-disabled:bg-muted"
        {...props}
      >
        <RadioPrimitive.Indicator
          data-slot="radio-indicator"
          className="size-2 rounded-full bg-foreground data-disabled:bg-disabled-foreground"
        />
      </RadioPrimitive.Root>
      {children ? <FieldLabel htmlFor={itemId}>{children}</FieldLabel> : null}
    </div>
  )
}

export { RadioGroup, RadioItem }
