"use client"

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

/**
 * The menu's chrome with free content inside it: a filter's date range, a
 * column picker, a short explanation with a link. A row that runs a command
 * belongs in a `Menu`; a popover is for the things a list of rows cannot hold.
 *
 * It is the same popup surface as `MenuContent` — white, one 1px
 * `--popover-border` hairline, `rounded-lg` — and it hangs 6px under its
 * trigger, the one offset every control on the height ladder shares. Padding
 * is 12px rather than the menu's 6, because content sits against the edge
 * where a menu row's own padding would have held it off.
 *
 * No shadow and no open or close animation, here as everywhere else: depth in
 * this design is the hairline.
 */
function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

/**
 * The control the popover is attached to. Like a menu trigger it leaves the
 * open-state fill to the control itself: `Button` declares one per variant,
 * and a trigger that is not a `Button` says so at its own call site.
 */
function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "end",
  side = "bottom",
  sideOffset = 6,
  ...props
}: PopoverPrimitive.Popup.Props & {
  align?: PopoverPrimitive.Positioner.Props["align"]
  side?: PopoverPrimitive.Positioner.Props["side"]
  sideOffset?: number
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "min-w-33 origin-(--transform-origin) rounded-lg border border-popover-border bg-popover p-3 text-popover-foreground outline-none",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
