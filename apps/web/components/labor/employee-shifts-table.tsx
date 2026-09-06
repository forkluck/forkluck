"use client"

import * as React from "react"

import { formatWorkedHours } from "@/components/labor/labor-format"
import { TimeEntryRateDialog } from "@/components/labor/time-entry-rate-dialog"
import { DataTable, dataTableColumns } from "@/components/ui/data-table"
import type { CurrencyCode } from "@/lib/business-settings"
import type { TimeEntryRow } from "@/lib/backend/types"
import { formatCents } from "@/lib/money"

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>()

function formatEntryDateTime(entry: TimeEntryRow, value: Date) {
  let formatter = dateTimeFormats.get(entry.importTimezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: entry.importTimezone,
    })
    dateTimeFormats.set(entry.importTimezone, formatter)
  }
  return formatter.format(value)
}

const entryHelper = dataTableColumns<TimeEntryRow>()

/** The 13.5px secondary cell every numeric column on this screen uses. */
function Cell({ children }: { children: React.ReactNode }) {
  return <span className="text-base text-muted-foreground">{children}</span>
}

/**
 * One employee's shifts, in the same table shell as the Labor list: two rules
 * closing it top and bottom, a 48px header, and 52px rows.
 */
export function EmployeeShiftsTable({
  entries,
  currencyCode,
}: {
  entries: TimeEntryRow[]
  currencyCode: CurrencyCode
}) {
  const [selectedEntry, setSelectedEntry] = React.useState<TimeEntryRow | null>(
    null
  )
  const columns = React.useMemo(
    () => [
      entryHelper.accessor((row) => row.clockIn.getTime(), {
        id: "clockIn",
        header: "Clock in",
        meta: { className: "w-[28%]" },
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            {formatEntryDateTime(row.original, row.original.clockIn)}
          </span>
        ),
      }),
      entryHelper.accessor((row) => row.clockOut.getTime(), {
        id: "clockOut",
        header: "Clock out",
        meta: { className: "w-[28%]" },
        cell: ({ row }) => (
          <Cell>
            <span className="whitespace-nowrap">
              {formatEntryDateTime(row.original, row.original.clockOut)}
            </span>
          </Cell>
        ),
      }),
      entryHelper.accessor((row) => row.paidSeconds, {
        id: "hours",
        header: "Hours",
        meta: { align: "right", className: "w-[13%]" },
        cell: ({ row }) => (
          <Cell>{formatWorkedHours(row.original.paidSeconds)}</Cell>
        ),
      }),
      entryHelper.accessor((row) => row.hourlyRateCents, {
        id: "rate",
        header: "Hourly rate",
        meta: { align: "right", className: "w-[15%]" },
        cell: ({ row }) => (
          <Cell>
            <button
              type="button"
              className="rounded-sm outline-none hover:underline hover:underline-offset-4 focus-visible:underline focus-visible:underline-offset-4"
              aria-label={`Edit shift rate for ${formatEntryDateTime(row.original, row.original.clockIn)}`}
              onClick={() => setSelectedEntry(row.original)}
            >
              {row.original.hourlyRateCents === null
                ? "Set rate"
                : formatCents(row.original.hourlyRateCents, currencyCode)}
            </button>
          </Cell>
        ),
      }),
      entryHelper.accessor((row) => row.laborCostCents, {
        id: "cost",
        header: "Labor cost",
        meta: { align: "right", className: "w-[16%]" },
        cell: ({ row }) => (
          <Cell>
            {row.original.laborCostCents === null
              ? "Needs a rate"
              : formatCents(row.original.laborCostCents, currencyCode)}
          </Cell>
        ),
      }),
    ],
    [currencyCode]
  )

  return (
    <>
      <DataTable
        columns={columns}
        data={entries}
        getRowId={(row) => row.id}
        emptyMessage="No shifts recorded in this period."
        tableClassName="table-fixed min-w-[720px]"
        rowClassName={() => "h-[52px]"}
        onRowClick={setSelectedEntry}
        hideToolbar
      />
      {selectedEntry ? (
        <TimeEntryRateDialog
          key={selectedEntry.id}
          entry={selectedEntry}
          currencyCode={currencyCode}
          onClose={() => setSelectedEntry(null)}
        />
      ) : null}
    </>
  )
}
