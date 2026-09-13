"use client"

import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { trialDaysLeftLabel } from "@/lib/billing"

/** The trial countdown beside the Analytics title, with the way to end it.
 * Paid and self-hosted accounts see nothing; a read-only account has the
 * banner above every screen instead. */
export function HomePlanBadge({
  trialDaysLeft,
}: {
  trialDaysLeft: number | null
}) {
  if (trialDaysLeft === null) return null
  return (
    <>
      <Badge>Trial, {trialDaysLeftLabel(trialDaysLeft)}</Badge>
      <Link
        href="/subscribe"
        className="text-md leading-5 font-medium underline-offset-4 hover:underline"
      >
        Subscribe
      </Link>
    </>
  )
}
