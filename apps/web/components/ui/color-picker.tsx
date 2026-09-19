"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * The colour picker: a grid of 24px `rounded-md` swatches over the app's own
 * palette, a 36px hex `Input` under it, and a native `<input type="color">`
 * behind an outline "Custom" button for a value the palette does not hold.
 *
 * The default swatches are the semantic and chart colours declared in
 * `app/globals.css`, in that file's order, so a colour chosen here is one the
 * rest of the app already draws. A call site with its own set passes
 * `swatches`; the hex field still takes anything.
 *
 * Every swatch is a real button carrying its hex as the accessible name, and
 * the selected one wears the ink border the rest of the design gives a
 * selected control — there is no ring anywhere here. The swatch is 24px, the
 * `xs` rung of the control ladder, so a row of them lines up with the buttons
 * beside it; the hex field is the standard 36px `Input`.
 */

/** The semantic and chart colours from `app/globals.css`, in that order. */
const DEFAULT_SWATCHES = [
  "#3273dc", // --brand
  "#d8e4f7", // --brand-fill
  "#18181b", // --foreground
  "#52525b", // --muted-foreground
  "#c9c9cf", // --line-strong
  "#2f5a3a", // --success
  "#d2e5c9", // --success-fill
  "#f9dca4", // --warning-fill
  "#d92d20", // --destructive
  "#f5cfc8", // --destructive-fill
  // --chart-2 is the same #d8e4f7 as --brand-fill above, so it is not drawn
  // twice: two identical swatches would carry the same accessible name and
  // both read as selected.
] as const

const HEX = /^#[0-9a-f]{6}$/i

function normalize(hex: string): string {
  return hex.trim().toLowerCase()
}

function ColorPicker({
  value,
  onValueChange,
  swatches = DEFAULT_SWATCHES as readonly string[],
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "onChange"> & {
  value: string
  onValueChange: (value: string) => void
  swatches?: readonly string[]
}) {
  const nativeRef = React.useRef<HTMLInputElement>(null)
  // The field keeps a draft while it is being typed into: a half-typed hex is
  // not a colour, so it never reaches the caller.
  const [draft, setDraft] = React.useState(value)
  const [lastValue, setLastValue] = React.useState(value)
  if (value !== lastValue) {
    // Adjusted during render rather than in an effect: a value chosen from a
    // swatch has to reach the field in the same pass, or the field shows the
    // old hex for a frame.
    setLastValue(value)
    setDraft(value)
  }

  const selected = normalize(value)
  const custom = HEX.test(selected) ? selected : "#000000"

  return (
    <div
      data-slot="color-picker"
      className={cn("flex w-fit flex-col gap-3", className)}
      {...props}
    >
      <div className="grid grid-cols-6 gap-2">
        {swatches.map((swatch, index) => {
          const hex = normalize(swatch)
          const isSelected = hex === selected
          return (
            <button
              key={`${hex}-${index}`}
              type="button"
              data-slot="color-swatch"
              aria-label={`Color ${hex}`}
              aria-pressed={isSelected}
              onClick={() => onValueChange(hex)}
              style={{ backgroundColor: hex }}
              className={cn(
                "size-6 rounded-md border outline-none focus-visible:border-foreground",
                isSelected ? "border-foreground" : "border-line-strong"
              )}
            />
          )
        })}
      </div>

      <div className="flex items-center gap-2">
        <Input
          aria-label="Hex value"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            const next = event.target.value
            setDraft(next)
            if (HEX.test(next)) onValueChange(normalize(next))
          }}
          className="w-28 font-mono"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => nativeRef.current?.click()}
        >
          Custom
        </Button>
        {/* The system picker is the escape hatch for a value the palette does
            not hold; the button above is what the page actually shows. */}
        <input
          ref={nativeRef}
          type="color"
          tabIndex={-1}
          aria-hidden="true"
          value={custom}
          onChange={(event) => onValueChange(normalize(event.target.value))}
          className="sr-only"
        />
      </div>
    </div>
  )
}

export { ColorPicker, DEFAULT_SWATCHES }
