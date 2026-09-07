"use client"

import Link from "next/link"
import * as React from "react"
import {
  Archive,
  ArchiveRestore,
  Download,
  Eye,
  EyeOff,
  History,
  SquarePen,
  Upload,
} from "lucide-react"

import {
  setEmployeeActive,
  setEmployeeExcludedFromCost,
} from "@/app/(app)/labor/actions"
import { AddEmployeeDialog } from "@/components/labor/add-employee-dialog"
import { EmployeeRateDialog } from "@/components/labor/employee-rate-dialog"
import { ImportHoursDialog } from "@/components/labor/import-labor-dialog"
import { LaborImportHistoryDialog } from "@/components/labor/labor-import-history-dialog"
import {
  decimalHours,
  formatDecimalHours,
} from "@/components/labor/labor-format"
import { LaborPeriodControls } from "@/components/labor/labor-period-controls"
import { LoadingRegion } from "@/components/ui/loading-region"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DataTable,
  dataTableColumns,
  type SegmentFilter,
} from "@/components/ui/data-table"
import { ActionsMenu } from "@/components/ui/actions-menu"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { useToast } from "@/components/ui/toast"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { CurrencyCode } from "@/lib/business-settings"
import type {
  EmployeeRow,
  LaborImportRow,
  LaborOverview,
  NetSalesTrend,
} from "@/lib/backend/types"
import { useCommit } from "@/hooks/use-commit"
import { formatCents } from "@/lib/money"
import { csvCell } from "@/lib/csv"
import { overtimeWeekLine } from "@/lib/labor/overtime"
import { cn } from "@/lib/utils"
import { useGuardedNavigate } from "@/components/navigation-blocker"

const employeeHelper = dataTableColumns<EmployeeRow>()

/** The 13.5px secondary cell every column but the name uses. */
function Cell({ children }: { children: React.ReactNode }) {
  return <span className="text-base text-muted-foreground">{children}</span>
}

function exportHours(
  rows: EmployeeRow[],
  formatShiftDate: (row: EmployeeRow) => string
) {
  const lines = [
    ["Employee", "Shifts", "Hours", "Hourly rate", "Labor cost", "Last shift"]
      .map((value) => csvCell(value))
      .join(","),
    ...rows.map((row) =>
      [
        csvCell(row.name),
        row.shiftCount,
        decimalHours(row.totalSeconds).toFixed(2),
        row.currentHourlyRateCents === null
          ? ""
          : (row.currentHourlyRateCents / 100).toFixed(2),
        row.excludedFromCost ? "" : (row.laborCostCents / 100).toFixed(2),
        csvCell(formatShiftDate(row)),
      ].join(",")
    ),
  ]
  const blob = new Blob([lines.join("\n")], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = "labor_hours_export.csv"
  anchor.click()
  URL.revokeObjectURL(url)
}

/** The grey Actions pill and its three-item popover. */
function LaborActionsMenu({
  onImport,
  onExport,
  onHistory,
}: {
  onImport: () => void
  onExport: () => void
  onHistory: () => void
}) {
  return (
    <ActionsMenu>
      <MenuItem onClick={onImport}>
        <Download strokeWidth={1.8} aria-hidden="true" />
        Import hours
      </MenuItem>
      <MenuItem onClick={onExport}>
        <Upload strokeWidth={1.8} aria-hidden="true" />
        Export hours
      </MenuItem>
      <MenuItem onClick={onHistory}>
        <History strokeWidth={1.8} aria-hidden="true" />
        Import history
      </MenuItem>
    </ActionsMenu>
  )
}

/**
 * Labor: the employee table over one period, with the period pills, the
 * import/export menu, and the row actions the design puts behind the `…`.
 */
export function LaborWorkspace({
  employees,
  imports,
  overtime,
  currencyCode,
  startDate,
  endDate,
  comparison,
  timeZone,
  today,
}: {
  employees: EmployeeRow[]
  imports: LaborImportRow[]
  overtime: LaborOverview["overtime"]
  currencyCode: CurrencyCode
  startDate: string
  endDate: string
  comparison: NetSalesTrend["comparison"]
  timeZone: string
  /** Today in the business timezone, as `YYYY-MM-DD`. */
  today: string
}) {
  const { go } = useGuardedNavigate()
  const toast = useToast()
  const [importOpen, setImportOpen] = React.useState(false)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [addOpen, setAddOpen] = React.useState(false)
  const [periodPending, setPeriodPending] = React.useState(false)
  const [rateEmployee, setRateEmployee] = React.useState<EmployeeRow | null>(
    null
  )
  // The active flag a row's own commit put on screen, over what the server sent.
  const [active, setActive] = React.useState<Record<string, boolean>>({})
  const [excluded, setExcluded] = React.useState<Record<string, boolean>>({})
  const commit = useCommit({})

  const shiftDateFormat = React.useMemo(
    () =>
      new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        timeZone,
      }),
    [timeZone]
  )
  const lastShift = React.useCallback(
    (row: EmployeeRow) =>
      row.lastShiftAt ? shiftDateFormat.format(row.lastShiftAt) : "—",
    [shiftDateFormat]
  )

  const employeeHref = React.useCallback(
    (employeeId: string) => {
      const params = new URLSearchParams({ start: startDate })
      if (endDate !== startDate) params.set("end", endDate)
      return `/labor/${employeeId}?${params}`
    },
    [endDate, startDate]
  )

  const toggleActive = React.useCallback(
    (employee: EmployeeRow) => {
      const previous = employee.isActive
      void commit({
        domain: `employee:${employee.id}:active`,
        apply: () =>
          setActive((current) => ({ ...current, [employee.id]: !previous })),
        revert: () =>
          setActive((current) => ({ ...current, [employee.id]: previous })),
        write: () =>
          setEmployeeActive({ employeeId: employee.id, isActive: !previous }),
      }).then((failure) => {
        if (failure)
          toast.add({
            title: previous
              ? `Couldn’t archive ${employee.name}`
              : `Couldn’t restore ${employee.name}`,
            description: failure.message,
            type: "error",
          })
      })
    },
    [commit, toast]
  )

  const toggleExcluded = React.useCallback(
    (employee: EmployeeRow) => {
      const previous = employee.excludedFromCost
      void commit({
        domain: `employee:${employee.id}:excluded`,
        apply: () =>
          setExcluded((current) => ({ ...current, [employee.id]: !previous })),
        revert: () =>
          setExcluded((current) => ({ ...current, [employee.id]: previous })),
        write: () =>
          setEmployeeExcludedFromCost({
            employeeId: employee.id,
            excludedFromCost: !previous,
          }),
      }).then((failure) => {
        if (failure)
          toast.add({
            title: previous
              ? `Couldn’t count ${employee.name} in cost`
              : `Couldn’t leave ${employee.name} out of cost`,
            description: failure.message,
            type: "error",
          })
      })
    },
    [commit, toast]
  )

  const rows = React.useMemo(
    () =>
      employees.map((employee) => {
        const flag = active[employee.id]
        const left = excluded[employee.id]
        if (flag === undefined && left === undefined) return employee
        return {
          ...employee,
          isActive: flag ?? employee.isActive,
          excludedFromCost: left ?? employee.excludedFromCost,
        }
      }),
    [active, excluded, employees]
  )

  const statusFilters = React.useMemo<Array<SegmentFilter<EmployeeRow>>>(
    () => [
      {
        label: "Status",
        options: [
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
        ],
        getValue: (row) => (row.isActive ? "active" : "archived"),
        defaultValue: "active",
      },
    ],
    []
  )

  const columns = React.useMemo(
    () => [
      employeeHelper.accessor((row) => row.name, {
        id: "employee",
        header: "Employee",
        meta: { className: "w-[32%] max-w-0" },
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            {/* A link, not bare text: the row is clickable, and a keyboard has
                to be able to reach the same destination. It carries no
                underline, so the cell reads exactly as the design draws it. */}
            <Link
              href={employeeHref(row.original.id)}
              className="truncate outline-none focus-visible:underline"
            >
              {row.original.name}
            </Link>
            {row.original.excludedFromCost ? (
              <span className="shrink-0 text-2xs text-muted-foreground">
                Not costed
              </span>
            ) : null}
          </div>
        ),
      }),
      employeeHelper.accessor((row) => row.shiftCount, {
        id: "shifts",
        header: "Shifts",
        meta: { align: "right", className: "w-[11%]" },
        cell: ({ row }) => <Cell>{row.original.shiftCount}</Cell>,
      }),
      employeeHelper.accessor((row) => row.totalSeconds, {
        id: "hours",
        header: "Hours",
        meta: { align: "right", className: "w-[11%]" },
        cell: ({ row }) => {
          const weeks = overtime.byEmployee[row.original.id]
          return (
            <span className="inline-flex items-center justify-end gap-1.5">
              {weeks?.length ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Badge variant="warning" size="row">
                        OT
                      </Badge>
                    }
                  />
                  <TooltipContent className="flex-col items-start gap-0.5">
                    {weeks.map((week) => (
                      <span key={week.weekStart}>{overtimeWeekLine(week)}</span>
                    ))}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <Cell>{formatDecimalHours(row.original.totalSeconds)}</Cell>
            </span>
          )
        },
      }),
      employeeHelper.accessor((row) => row.currentHourlyRateCents ?? -1, {
        id: "hourlyRate",
        header: "Hourly rate",
        meta: { align: "right", className: "w-[14%]" },
        cell: ({ row }) => (
          <Cell>
            {row.original.currentHourlyRateCents === null
              ? "—"
              : formatCents(row.original.currentHourlyRateCents, currencyCode)}
          </Cell>
        ),
      }),
      employeeHelper.accessor((row) => row.laborCostCents, {
        id: "laborCost",
        header: "Labor cost",
        meta: { align: "right", className: "w-[14%]" },
        cell: ({ row }) => (
          <Cell>
            {row.original.excludedFromCost
              ? "—"
              : formatCents(row.original.laborCostCents, currencyCode)}
          </Cell>
        ),
      }),
      employeeHelper.accessor((row) => row.lastShiftAt?.getTime() ?? 0, {
        id: "lastShift",
        header: "Last shift",
        meta: { align: "right", className: "w-[13%]" },
        cell: ({ row }) => (
          <Cell>
            <span className="whitespace-nowrap">{lastShift(row.original)}</span>
          </Cell>
        ),
      }),
      employeeHelper.display({
        id: "actions",
        enableHiding: false,
        meta: { className: "w-[5%] min-w-11" },
        cell: ({ row }) => (
          <div className="flex justify-end">
            <RowActionsMenu label={`Actions for ${row.original.name}`}>
              <MenuItem onClick={() => setRateEmployee(row.original)}>
                <SquarePen strokeWidth={1.8} aria-hidden="true" />
                Edit rate
              </MenuItem>
              <MenuItem onClick={() => toggleExcluded(row.original)}>
                {row.original.excludedFromCost ? (
                  <>
                    <Eye strokeWidth={1.8} aria-hidden="true" />
                    Count in cost
                  </>
                ) : (
                  <>
                    <EyeOff strokeWidth={1.8} aria-hidden="true" />
                    Leave out of cost
                  </>
                )}
              </MenuItem>
              <MenuItem onClick={() => toggleActive(row.original)}>
                {row.original.isActive ? (
                  <>
                    <Archive strokeWidth={1.8} aria-hidden="true" />
                    Archive
                  </>
                ) : (
                  <>
                    <ArchiveRestore strokeWidth={1.8} aria-hidden="true" />
                    Restore
                  </>
                )}
              </MenuItem>
            </RowActionsMenu>
          </div>
        ),
      }),
    ],
    [
      currencyCode,
      employeeHref,
      lastShift,
      overtime,
      toggleActive,
      toggleExcluded,
    ]
  )

  return (
    <>
      <LoadingRegion pending={periodPending} label="Loading period">
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          tableClassName="table-fixed min-w-[760px]"
          emptyMessage="No employees match your search."
          rowClassName={(row) => cn("h-[52px]", !row.isActive && "opacity-60")}
          segmentFilters={statusFilters}
          onRowClick={(employee) => void go(employeeHref(employee.id))}
          toolbarLeading={
            <LaborPeriodControls
              startDate={startDate}
              endDate={endDate}
              comparison={comparison}
              timeZone={timeZone}
              onPendingChange={setPeriodPending}
            />
          }
          toolbarExtra={({ visibleRows }) => (
            <>
              <LaborActionsMenu
                onImport={() => setImportOpen(true)}
                onExport={() => exportHours(visibleRows, lastShift)}
                onHistory={() => setHistoryOpen(true)}
              />
              <Button onClick={() => setAddOpen(true)}>Add employee</Button>
            </>
          )}
        />
      </LoadingRegion>

      <ImportHoursDialog open={importOpen} onOpenChange={setImportOpen} />
      <LaborImportHistoryDialog
        imports={imports}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      />
      <AddEmployeeDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onImportHours={() => {
          setAddOpen(false)
          setImportOpen(true)
        }}
      />
      {rateEmployee ? (
        <EmployeeRateDialog
          key={rateEmployee.id}
          employee={rateEmployee}
          today={today}
          timeZone={timeZone}
          onClose={() => setRateEmployee(null)}
        />
      ) : null}
    </>
  )
}
