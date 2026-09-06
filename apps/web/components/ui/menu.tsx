"use client"

import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

function Menu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />
}

/**
 * A trigger keeps a fill while its menu is open, so an open menu reads as
 * attached to the control that opened it — but *which* fill is the control's
 * business, not the menu's. `Button` declares it per variant (a grey Actions
 * pill goes one step darker, a ghost pill picks up the grey). A trigger that
 * is not a Button says so itself, the way the sidebar's account row does.
 * Putting a blanket fill here made the two rules collide and let Tailwind's
 * emitted order decide the winner.
 */
function MenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />
}

/**
 * 6px below the trigger. Every control that opens a menu is on the height
 * ladder now, so there is no second offset for a shorter trigger.
 */
function MenuContent({
  className,
  align = "end",
  side = "bottom",
  sideOffset = 6,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"]
  side?: MenuPrimitive.Positioner.Props["side"]
  sideOffset?: number
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="z-50"
      >
        {/* Popover chrome: white, one 1px hairline, `rounded-lg`, padding 6.
            No shadow and no open/close animation anywhere in this design. */}
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            "min-w-33 origin-(--transform-origin) rounded-lg border border-popover-border bg-popover p-1.5 text-popover-foreground outline-none",
            className
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

/**
 * Popover item: 36px tall, `rounded-md`, `0 10px` padding, 400 14px ink, 10px gap
 * to a 17px icon that inherits the row's color. Hover is the grey fill;
 * destructive rows (the ones call sites mark with `text-destructive`) swap it
 * for the pale red.
 *
 * **A command row always carries an icon**, and it is not decoration: the icon
 * plus the gap is a 27px lane, so a row without one starts its label 27px to
 * the left. Skip it on one menu and that menu's labels no longer line up with
 * the next menu's, which is the only reason the popovers in this app ever
 * looked like they belonged to different products. Mark it `aria-hidden` — the
 * label already says what the row does.
 *
 * A row that picks a value rather than running a command is a `MenuCheckItem`
 * instead. That reserves the 15px check slot in the same lane, so a choice
 * menu and a command menu still agree about where text begins.
 */
const itemClassName =
  "flex h-9 w-full cursor-default items-center gap-2.5 rounded-md px-2.5 text-md leading-none font-normal text-popover-foreground outline-none select-none data-disabled:cursor-not-allowed data-disabled:text-disabled-foreground data-highlighted:bg-accent [&.text-destructive]:data-highlighted:bg-destructive-fill [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[17px]"

function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(itemClassName, className)}
      {...props}
    />
  )
}

function MenuLinkItem({ className, ...props }: MenuPrimitive.LinkItem.Props) {
  return (
    <MenuPrimitive.LinkItem
      data-slot="menu-link-item"
      className={cn(itemClassName, className)}
      {...props}
    />
  )
}

/**
 * A row of a single-select menu. It reserves the handoff's 15px check slot —
 * the chosen row shows an ink check, the row under the cursor a pale one,
 * every other row a blank spacer — so picking an option never shifts the list.
 */
function MenuCheckItem({
  checked = false,
  children,
  ...props
}: MenuPrimitive.Item.Props & { checked?: boolean }) {
  return (
    <MenuItem data-checked={checked || undefined} {...props}>
      <Check
        aria-hidden="true"
        strokeWidth={2}
        className={cn(
          "size-[15px]",
          checked
            ? "text-foreground"
            : "text-disabled-foreground opacity-0 [[data-highlighted]_&]:opacity-100"
        )}
      />
      {children}
    </MenuItem>
  )
}

export { Menu, MenuCheckItem, MenuContent, MenuItem, MenuLinkItem, MenuTrigger }
