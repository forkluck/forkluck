"use client"

import * as React from "react"

import { inputClassName } from "@/components/ui/input"
import { cn } from "@/lib/utils"

const labelClassName = "text-sm leading-none font-medium text-foreground"

/**
 * A label-above field: a 13px medium label on its own line, an 8px gap, then
 * the 36px `Input` box. Same label as `FieldTitle`, same box as `Input`.
 */
function LabeledInput({
  label,
  id,
  className,
  containerClassName,
  trailing,
  ...props
}: React.ComponentProps<"input"> & {
  label: string
  containerClassName?: string
  /** Right-edge accessory (a unit picker, an icon button) inside the box. */
  trailing?: React.ReactNode
}) {
  const reactId = React.useId()
  const inputId = id ?? reactId
  return (
    <div className={cn("flex flex-col gap-2", containerClassName)}>
      {/* The label reddens with its field, so the eye lands on the name. */}
      <label
        htmlFor={inputId}
        className={cn(
          labelClassName,
          props["aria-invalid"] && "text-destructive"
        )}
      >
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          {...props}
          className={cn(
            inputClassName,
            "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
            trailing && "pr-14",
            className
          )}
        />
        {trailing ? (
          <div className="absolute top-1/2 right-3 -translate-y-1/2">
            {trailing}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The same label above a control that owns its own box, like a `Select`
 * trigger: the child fills the width. */
function LabeledShell({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { label: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      <span className={labelClassName}>{label}</span>
      {children}
    </div>
  )
}

/** What a control inside a `LabeledShell` wears to match `LabeledInput`. */
const labeledControlClassName =
  "w-full rounded-md px-3 text-md data-[size=default]:h-9"

export { LabeledInput, LabeledShell, labeledControlClassName }
