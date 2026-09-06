"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuTrigger,
} from "@/components/ui/menu"
import { cn } from "@/lib/utils"

/**
 * The toolbar's filter pill and the single-select popover under it: the label
 * is the quiet half, the chosen value carries the ink, and every row reserves
 * a 15px check slot so picking one shifts nothing.
 *
 * Every filter in the app is this — Date's sibling `vs`, Products' Status,
 * Invoices' Status and Supplier, Recipes' Type and Category.
 */
/**
 * The pill itself, without a selection model. Always used as a `MenuTrigger`'s
 * `render`, which is what supplies the open state the `filter` variant reacts
 * to.
 */
function FilterPillTrigger({
  label,
  value,
  className,
  ...props
}: React.ComponentProps<typeof Button> & {
  label?: React.ReactNode
  value: React.ReactNode
}) {
  return (
    <Button
      variant="filter"
      className={cn("shrink-0 gap-1.5", className)}
      {...props}
    >
      {label}
      <span className="font-medium text-foreground">{value}</span>
    </Button>
  )
}

export function FilterPill<Value extends string>({
  label,
  value,
  valueLabel,
  options,
  onSelect,
  pending = false,
  className,
  contentClassName,
  align = "start",
}: {
  /** Omitted when the pill shows only its value. */
  label?: string
  value: Value
  valueLabel?: string
  options: Array<{ value: Value; label: string }>
  onSelect: (value: Value) => void
  /** True while the value just picked is still on its way to the screen. */
  pending?: boolean
  className?: string
  contentClassName?: string
  align?: "start" | "center" | "end"
}) {
  const selected = options.find((option) => option.value === value)

  return (
    <Menu>
      <MenuTrigger
        render={
          <FilterPillTrigger
            label={label}
            value={valueLabel ?? selected?.label}
            pending={pending}
            className={className}
            aria-label={
              label ? `${label}: ${selected?.label ?? ""}` : undefined
            }
          />
        }
      />
      <MenuContent align={align} className={cn("w-[168px]", contentClassName)}>
        {options.map((option) => (
          <MenuCheckItem
            key={option.value}
            checked={option.value === value}
            onClick={() => onSelect(option.value)}
          >
            {option.label}
          </MenuCheckItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
