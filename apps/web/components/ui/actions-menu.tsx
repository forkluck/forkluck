"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu"
import { cn } from "@/lib/utils"

/**
 * The grey **Actions** pill at the right end of a toolbar, next to the black
 * primary: import, export, history — the things a screen can do that are not
 * "add one". A 32px grey pill with a 13px chevron, opening a 184px popover.
 *
 * Recipes, Ingredients, Labor and Sales each drew their own in the first pass,
 * with three different chevron sizes and four popover widths.
 */
export function ActionsMenu({
  label = "Actions",
  className,
  align = "end",
  disabled = false,
  children,
}: {
  label?: React.ReactNode
  /** Widens the popover past the 184px default (Ingredients runs 196px). */
  className?: string
  /** `start` when the pill sits on the left of a toolbar rather than its end. */
  align?: "start" | "center" | "end"
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={<Button variant="secondary" className="shrink-0" />}
      >
        {label}
        <ChevronDown
          className="size-[13px]"
          strokeWidth={2}
          aria-hidden="true"
        />
      </MenuTrigger>
      <MenuContent align={align} className={cn("w-46", className)}>
        {children}
      </MenuContent>
    </Menu>
  )
}
