"use client"

import * as React from "react"
import { Ellipsis } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu"
import { cn } from "@/lib/utils"

/**
 * The `…` that ends every table row: a 32px ghost icon button holding three
 * filled dots, opening a 176px popover.
 *
 * The dots are filled circles at r=1.6, not rings — lucide draws r=1, so the
 * 1.2 stroke plus `fill-current` lands on the handoff's radius. Every table
 * used to spell that out itself, and half of them got outlined rings instead.
 *
 *   <RowActionsMenu label={`Actions for ${row.name}`}>
 *     <MenuItem …>
 *       <SquarePen strokeWidth={1.8} aria-hidden="true" />
 *       Edit
 *     </MenuItem>
 *   </RowActionsMenu>
 */
export function RowActionsMenu({
  label,
  children,
  className,
  align = "end",
  disabled = false,
}: {
  /** What the button announces, e.g. `Actions for Butter Croissant`. */
  label: string
  children: React.ReactNode
  /** Widens the popover past the 176px default. */
  className?: string
  align?: "start" | "center" | "end"
  /**
   * Closes the whole menu off, for a row whose every action is unavailable.
   * Disabling the items instead leaves a button that opens a popover of
   * things you cannot do, which reads as broken rather than as unavailable.
   */
  disabled?: boolean
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={disabled}
          />
        }
      >
        <Ellipsis
          className="size-[18px] fill-current"
          strokeWidth={1.2}
          aria-hidden="true"
        />
      </MenuTrigger>
      <MenuContent align={align} className={cn("w-44", className)}>
        {children}
      </MenuContent>
    </Menu>
  )
}
