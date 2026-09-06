"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Pagination } from "@/lib/backend/pagination"

export function BrowsePagination({
  pagination,
  onPageChange,
  pending = false,
}: {
  pagination: Pagination
  onPageChange: (page: number) => void
  pending?: boolean
}) {
  if (pagination.total === 0) return null

  return (
    <nav
      aria-label="Pagination"
      aria-busy={pending}
      className="mt-4 flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm text-muted-foreground"
    >
      <span className="tabular-nums">
        Page {pagination.page} of {Math.max(pagination.pages, 1)} ·{" "}
        {pagination.total.toLocaleString()} total
      </span>
      <span className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Previous page"
          disabled={pending || pagination.prev === null}
          onClick={() => {
            if (pagination.prev !== null) onPageChange(pagination.prev)
          }}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Next page"
          disabled={pending || pagination.next === null}
          onClick={() => {
            if (pagination.next !== null) onPageChange(pagination.next)
          }}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </span>
    </nav>
  )
}
