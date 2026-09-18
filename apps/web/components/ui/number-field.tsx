"use client"

import * as React from "react"
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field"
import { Minus, Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { inputClassName } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * A quantity a cook steps up and down: batch size, yield, days of cover. The
 * shell is the `Input` shell itself (`inputClassName`, 36px, `rounded-md`, one
 * `--input` hairline) so a number field and a text field in the same form draw
 * the same edge at the same height; only the padding changes, because the
 * steppers live inside the box.
 *
 * The steppers are the 24px `xs` icon button in `ghost`, the quietest rung, at
 * the two ends of the field, with 14px `Minus` and `Plus`. Ghost keeps the
 * inside of the field flat until a stepper is under the cursor, so the field
 * still reads as one control rather than three.
 *
 * The shell cannot take the input's own `:focus-visible` and `:enabled`
 * states — it is a div — so it wears the same two changes through
 * `focus-within` and a plain hover: the line firms to `--line-strong` on
 * hover and turns ink on focus. There is no focus ring here either.
 *
 * Base UI's input is a formatted `type="text"` box, so the spinbutton role and
 * its value bounds are declared here: that is what makes the control announce
 * as a number with a range rather than as free text.
 */
function NumberField({
  label,
  value,
  onValueChange,
  min,
  max,
  step,
  disabled,
  id,
  className,
  ...props
}: Omit<NumberFieldPrimitive.Root.Props, "className"> & {
  label?: React.ReactNode
  className?: string
}) {
  const generatedId = React.useId()
  const fieldId = id ?? generatedId

  return (
    <NumberFieldPrimitive.Root
      data-slot="number-field"
      id={fieldId}
      value={value}
      onValueChange={onValueChange}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn("flex w-full flex-col gap-2", className)}
      {...props}
    >
      {label ? <Label htmlFor={fieldId}>{label}</Label> : null}
      <NumberFieldPrimitive.Group
        data-slot="number-field-group"
        className={cn(
          inputClassName,
          "flex items-center gap-1 px-1 focus-within:border-foreground hover:not-focus-within:border-line-strong data-disabled:cursor-not-allowed data-disabled:border-border data-disabled:bg-fill-soft"
        )}
      >
        <NumberFieldPrimitive.Decrement
          render={
            <Button variant="ghost" size="icon-compact" aria-label="Decrease" />
          }
        >
          <Minus className="size-3.5" aria-hidden="true" />
        </NumberFieldPrimitive.Decrement>
        <NumberFieldPrimitive.Input
          role="spinbutton"
          aria-valuenow={value ?? undefined}
          aria-valuemin={min}
          aria-valuemax={max}
          className="h-full min-w-0 flex-1 bg-transparent text-center text-lg leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-muted-foreground md:text-md"
        />
        <NumberFieldPrimitive.Increment
          render={
            <Button variant="ghost" size="icon-compact" aria-label="Increase" />
          }
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </NumberFieldPrimitive.Increment>
      </NumberFieldPrimitive.Group>
    </NumberFieldPrimitive.Root>
  )
}

export { NumberField }
