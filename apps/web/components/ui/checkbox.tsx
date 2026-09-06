"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { CheckIcon, MinusIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A 15px box with a 1px grey edge, ink when it is on — selection is never the
 * accent here, because blue is reserved for data. Partial selection (the
 * header box over a part-selected table) shows a dash on the same ink fill.
 *
 * No focus ring: focus turns the border ink like every other control. The
 * `after:` pseudo-element widens the hit area past the 15px box without
 * changing what is drawn.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group/checkbox relative flex size-[15px] shrink-0 items-center justify-center rounded-sm border border-faint bg-card text-background outline-none after:absolute after:-inset-x-2 after:-inset-y-2 focus-visible:border-foreground disabled:cursor-not-allowed disabled:border-border disabled:bg-muted aria-invalid:border-destructive data-indeterminate:border-foreground data-indeterminate:bg-foreground data-checked:border-foreground data-checked:bg-foreground",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current"
      >
        <CheckIcon
          strokeWidth={3}
          className="size-[11px] group-data-indeterminate/checkbox:hidden"
        />
        <MinusIcon
          strokeWidth={3}
          className="hidden size-[11px] group-data-indeterminate/checkbox:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
