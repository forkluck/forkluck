"use client"

import { Users } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { RecipeDetail } from "@/lib/backend/types"
import { listNames } from "@/lib/recipe/names"

/**
 * Everyone the share dialog lists, in its order: accounts by name, then the
 * invited addresses. One address can hold both a guest link and a book, and
 * is one person.
 */
export function sharedWith({
  shares,
  guestLinks,
  bookLinks,
}: {
  shares: RecipeDetail["shares"]
  guestLinks: RecipeDetail["guestLinks"]
  bookLinks: RecipeDetail["bookLinks"]
}): string[] {
  const people = shares.map((share) => share.recipientName)
  const seen = new Set<string>()
  for (const link of [...guestLinks, ...bookLinks]) {
    const key = link.email.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    people.push(link.email)
  }
  return people
}

/**
 * The header's Share: the count of people the recipe reaches, and their
 * names on hover, so the owner need not open the dialog to know. The props
 * are the dialog's, so the two never disagree about who is listed.
 */
export function ShareButton({
  shares,
  guestLinks,
  bookLinks = [],
  disabled = false,
  onClick,
}: {
  shares: RecipeDetail["shares"]
  guestLinks: RecipeDetail["guestLinks"]
  bookLinks?: RecipeDetail["bookLinks"]
  disabled?: boolean
  onClick: () => void
}) {
  const people = sharedWith({ shares, guestLinks, bookLinks })
  const button = (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
    >
      <Users data-icon="inline-start" strokeWidth={1.8} aria-hidden="true" />
      Share
      {people.length > 0 ? <Badge>{people.length}</Badge> : null}
    </Button>
  )
  if (people.length === 0) return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>Shared with {listNames(people)}</TooltipContent>
    </Tooltip>
  )
}
