"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"

import { cn } from "@/lib/utils"
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"

const Select = SelectPrimitive.Root

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1", className)}
      {...props}
    />
  )
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    />
  )
}

/**
 * The handoff's picker: 36px, `rounded-md`, `padding:0 12px`, a 13px chevron in
 * `--muted-foreground`.
 *
 * Base UI's `SelectValue` renders whatever the *value* is when no item is
 * mounted to translate it, so a Select whose values are ids shows a raw id in
 * the trigger. Give `SelectValue` a children function (or a value→label map)
 * whenever the values are not the labels.
 */
function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        // No focus ring anywhere in this design: focus firms the border to
        // ink, hover to the one step below it. The trigger keeps the popover's
        // grey fill while its list is open.
        // 36px like every other input, `rounded-md`, one hairline. No focus ring:
        // the border goes ink. The grey fill is reserved for "list is open".
        // `padding:0 12px` with a 13px chevron, per the handoff's picker.
        "flex w-fit items-center justify-between gap-1.5 rounded-md border border-input bg-card px-3 py-0 text-md whitespace-nowrap outline-none select-none focus-visible:border-foreground enabled:not-focus:hover:border-line-strong disabled:cursor-not-allowed disabled:border-border disabled:text-disabled-foreground disabled:opacity-100 aria-invalid:border-destructive data-placeholder:text-faint data-popup-open:bg-accent data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[17px]",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDownIcon
            strokeWidth={2}
            className="pointer-events-none size-[13px] text-muted-foreground"
          />
        }
      />
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  alignItemWithTrigger = false,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn(
            // Same popover chrome as the menu: white, one hairline, `rounded-lg`,
            // padding 6, no shadow and no animation.
            "relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-33 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-popover-border bg-popover p-1.5 text-popover-foreground",
            className
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn(
        "px-3 pt-2 pb-1 text-2xs leading-none font-medium text-faint",
        className
      )}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "group relative flex min-h-9 w-full cursor-default items-center gap-2.5 rounded-md px-2.5 text-md leading-none font-normal text-popover-foreground outline-hidden select-none data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[17px]",
        className
      )}
      {...props}
    >
      {/* The 15px check slot a single-select popover always reserves: the
          selected row shows an ink check, the row under the cursor a pale one,
          every other row a blank spacer so nothing shifts. */}
      <span
        aria-hidden="true"
        className="relative flex size-[15px] shrink-0 items-center justify-center"
      >
        <CheckIcon
          strokeWidth={2}
          className="size-[15px] text-disabled-foreground opacity-0 group-data-highlighted:opacity-100 group-data-selected:hidden"
        />
        <SelectPrimitive.ItemIndicator
          render={
            <span className="absolute inset-0 flex items-center justify-center" />
          }
        >
          <CheckIcon strokeWidth={2} className="size-[15px] text-foreground" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
        {children}
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn(
        "pointer-events-none -mx-1 my-1 h-px bg-popover-border",
        className
      )}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
