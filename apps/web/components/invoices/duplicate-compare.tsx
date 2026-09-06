"use client"

import * as React from "react"
import Link from "next/link"

import { useBusinessSettings } from "@/components/business-settings-provider"
import { Button } from "@/components/ui/button"
import { formatCalendarDayMonth, formatDateTime } from "@/lib/datetime"
import type { ExistingInvoiceRef } from "@/lib/invoice-import"
import { formatCents } from "@/lib/money"
import { cn } from "@/lib/utils"

/**
 * This receipt beside the invoice already in the book, with the two answers:
 * keep what is there, or replace it. Keeping both is an edit, not a button —
 * the fingerprint Django refuses is the number (else date and total), so a
 * changed number is what makes this a different invoice.
 *
 * The rows that disagree are the whole point, so those are the ones drawn in
 * ink; the ones that match stay quiet.
 */
export function DuplicateCompare({
  current,
  existing,
  currencyCode,
  busy,
  onKeepExisting,
  onReplace,
}: {
  current: {
    invoiceNumber: string
    invoiceDate: string
    totalCents: number | null
    lineCount: number
  }
  existing: ExistingInvoiceRef
  currencyCode: string
  busy: boolean
  onKeepExisting: () => void
  onReplace: () => void
}) {
  const { timezone } = useBusinessSettings()
  const rows: { label: string; mine: string; theirs: string }[] = [
    {
      label: "Number",
      mine: current.invoiceNumber || "—",
      theirs: existing.invoiceNumber || "—",
    },
    {
      label: "Date",
      mine: formatCalendarDayMonth(current.invoiceDate || null),
      theirs: formatCalendarDayMonth(existing.invoiceDate),
    },
    {
      label: "Total",
      mine:
        current.totalCents === null
          ? "—"
          : formatCents(current.totalCents, currencyCode),
      theirs: formatCents(existing.totalCents, currencyCode),
    },
    {
      label: "Lines",
      mine: String(current.lineCount),
      theirs: String(existing.lineCount),
    },
    {
      label: "Imported on",
      mine: "—",
      theirs: formatDateTime(new Date(existing.importedAt), timezone),
    },
  ]

  return (
    <div className="rounded-xl border border-warning-border bg-warning-fill p-3.5">
      <p className="text-xs leading-[1.55] text-warning-foreground">
        An invoice like this one is already on file.
      </p>
      <dl className="mt-3 grid grid-cols-[minmax(0,84px)_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        <span />
        <span className="text-2xs font-medium text-ink-soft">This receipt</span>
        <span className="text-2xs font-medium text-ink-soft">
          Already imported
        </span>
        {rows.map((row) => {
          const differs = row.mine !== row.theirs
          return (
            <React.Fragment key={row.label}>
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd
                className={cn(
                  "tabular truncate",
                  differs ? "font-medium text-foreground" : "text-ink-soft"
                )}
              >
                {row.mine}
              </dd>
              <dd
                className={cn(
                  "tabular truncate",
                  differs ? "font-medium text-foreground" : "text-ink-soft"
                )}
              >
                {row.theirs}
              </dd>
            </React.Fragment>
          )
        })}
      </dl>
      <Link
        href={`/invoices/${existing.publicId}`}
        className="mt-2.5 inline-block text-xs text-primary underline-offset-4 hover:underline"
      >
        Open the imported invoice
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onKeepExisting}
        >
          Keep existing
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={onReplace}
        >
          Replace
        </Button>
      </div>
      <p className="mt-2 text-xs leading-[1.55] text-muted-foreground">
        To keep both, change the number, date or total above, then Import.
        Replace deletes the imported invoice and imports this one.
      </p>
    </div>
  )
}
