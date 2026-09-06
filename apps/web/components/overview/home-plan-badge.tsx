"use client"

import Link from "next/link"

import { Badge } from "@/components/ui/badge"

export function HomePlanBadge({ freePlan }: { freePlan: boolean }) {
  if (!freePlan) return null
  return (
    <>
      <Badge>Free</Badge>
      <Link
        href="/subscribe"
        className="text-md leading-5 font-medium underline-offset-4 hover:underline"
      >
        Upgrade
      </Link>
    </>
  )
}
