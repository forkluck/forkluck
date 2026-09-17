"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The press button: a button that stays down. It wears the outline `Button`
 * shell — 32px, `rounded-lg`, one `--input` hairline on the card fill — so it
 * lines up with the buttons beside it in a toolbar, and `size="icon"` is the
 * 32px square counterpart for the icon-only case.
 *
 * Pressed is the filled grey (`--secondary-strong`), border and fill together,
 * not the ink of a primary button and not the accent: a held control is a
 * state, not the one action of the view. Focus turns the border ink, since
 * there is no focus ring anywhere in this design.
 */
function Toggle({
  className,
  size = "default",
  ...props
}: TogglePrimitive.Props & { size?: "default" | "icon" }) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(
        buttonVariants({ variant: "outline", size }),
        "data-pressed:border-secondary-strong data-pressed:bg-secondary-strong data-pressed:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Toggle }
