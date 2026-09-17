"use client"

import * as React from "react"

import { ColorPicker } from "@/components/ui/color-picker"
import { Input, InputAffix, InputGroup } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * A colour as a labelled field: the `LabeledInput` label above the standard
 * 36px `Input`, the hex as the value, and a 16px `rounded-sm` swatch on the
 * field's own 12px inset. Clicking the swatch opens `ColorPicker` in a
 * `Popover`, so the palette is one press away and the field still takes a hex
 * typed straight in.
 *
 * The swatch itself is an `InputAffix` — that is what owns the 12px inset and
 * the vertical centering, and it is deliberately not a click target. The
 * trigger is a transparent 36px button sitting over that lane, which keeps the
 * affix's contract intact and still gives the swatch a real button with a
 * name. The input pads past it, the way the money field pads past its `$`.
 */
const HEX = /^#[0-9a-f]{6}$/i

function ColorField({
  label,
  value,
  onValueChange,
  id,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "onChange"> & {
  label: string
  value: string
  onValueChange: (value: string) => void
  id?: string
}) {
  const reactId = React.useId()
  const inputId = id ?? reactId
  const swatch = HEX.test(value.trim()) ? value.trim().toLowerCase() : undefined

  return (
    <div
      data-slot="color-field"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    >
      <label
        htmlFor={inputId}
        className="text-sm leading-none font-medium text-foreground"
      >
        {label}
      </label>
      <InputGroup>
        <InputAffix>
          <span
            data-slot="color-field-swatch"
            style={swatch ? { backgroundColor: swatch } : undefined}
            className={cn(
              "block size-4 rounded-sm border border-line-strong",
              swatch ? undefined : "bg-fill-soft"
            )}
          />
        </InputAffix>
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Choose a color"
                className="absolute inset-y-0 left-0 w-9 rounded-md outline-none focus-visible:border focus-visible:border-foreground"
              />
            }
          />
          <PopoverContent align="start" side="bottom" sideOffset={6}>
            <ColorPicker value={value} onValueChange={onValueChange} />
          </PopoverContent>
        </Popover>
        <Input
          id={inputId}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onValueChange(event.target.value)}
          className="pl-[34px] font-mono"
        />
      </InputGroup>
    </div>
  )
}

export { ColorField }
