import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { EmployeeRateButton } from "@/components/labor/employee-rate-button"
import { EmployeeShiftPeriodControl } from "@/components/labor/employee-shift-period-control"
import { EmployeeShiftsTable } from "@/components/labor/employee-shifts-table"
import { formatDecimalHours } from "@/components/labor/labor-format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Page,
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
} from "@/components/ui/page"
import { MetricCard } from "@/components/ui/metric-card"
import { requireUser } from "@/lib/auth-session"
import { localDateKey } from "@/lib/date-presets"
import { formatCents, formatWholeCents } from "@/lib/money"
import { dateSearchParam, rangeEndSearchParam } from "@/lib/date-search-param"
import { uuidParam } from "@/lib/uuid-param"
import {
  getBusinessSettings,
  getLaborEmployeeDetail,
} from "@/lib/backend/queries"
import { positivePage, singleSearchParam } from "@/lib/backend/pagination"
import { formatCalendarDate } from "@/lib/datetime"

function pageHref(
  employeeId: string,
  page: number,
  startDate: string,
  endDate: string
) {
  const params = new URLSearchParams({ start: startDate })
  if (endDate !== startDate) params.set("end", endDate)
  if (page > 1) params.set("page", String(page))
  return `/labor/${employeeId}?${params}`
}

export const metadata: Metadata = { title: "Employee" }

export default async function EmployeeLaborPage({
  params,
  searchParams,
}: {
  params: Promise<{ employeeId: string }>
  searchParams: Promise<{
    page?: string | string[]
    start?: string | string[]
    end?: string | string[]
  }>
}) {
  await requireUser()
  const [{ employeeId }, filters] = await Promise.all([params, searchParams])
  // An id the internal route table cannot match is an employee that does not
  // exist, the same as an id it can match but does not find.
  const requestedId = uuidParam(employeeId)
  if (!requestedId) notFound()
  const requestedPage = positivePage(singleSearchParam(filters.page))
  const startDate = dateSearchParam(filters.start)
  const endDate = rangeEndSearchParam(startDate, filters.end)
  const [detail, settings] = await Promise.all([
    getLaborEmployeeDetail(requestedId, requestedPage, startDate, endDate),
    getBusinessSettings(),
  ])
  if (!detail) notFound()

  const { employee, shifts, pagination } = detail

  return (
    <Page>
      <PageHeader className="flex-wrap">
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            <PageParent href="/labor">Labor</PageParent>
          </PageParents>
          <PageTitle>
            <span className="truncate">{employee.name}</span>
            {employee.isActive ? null : <Badge size="row">Archived</Badge>}
          </PageTitle>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EmployeeShiftPeriodControl
            startDate={detail.period.start}
            endDate={detail.period.end}
            timeZone={detail.period.timezone}
          />
          <EmployeeRateButton
            employee={employee}
            today={localDateKey(detail.period.timezone)}
            timeZone={detail.period.timezone}
          />
        </div>
      </PageHeader>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Shifts"
          value={String(employee.shiftCount)}
          note={
            employee.uncostedCount
              ? `${employee.uncostedCount} without a rate`
              : undefined
          }
        />
        <MetricCard
          label="Hours worked"
          value={formatDecimalHours(employee.totalSeconds)}
        />
        <MetricCard
          label="Labor cost"
          value={formatWholeCents(
            employee.laborCostCents,
            settings.currencyCode
          )}
        />
        <MetricCard
          label="Hourly rate"
          value={
            employee.currentHourlyRateCents === null
              ? "—"
              : formatCents(
                  employee.currentHourlyRateCents,
                  settings.currencyCode
                )
          }
          note={
            employee.currentRateEffectiveFrom
              ? `Since ${formatCalendarDate(employee.currentRateEffectiveFrom)}`
              : undefined
          }
        />
      </div>

      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="text-md leading-5 font-semibold">Shift history</h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          {pagination.total === 1
            ? "1 recorded shift"
            : `${pagination.total} recorded shifts`}
          {pagination.pages > 1
            ? ` · page ${pagination.page} of ${pagination.pages}`
            : ""}
        </p>
      </div>

      <EmployeeShiftsTable
        entries={shifts}
        currencyCode={settings.currencyCode}
      />

      {pagination.pages > 1 ? (
        <nav
          className="mt-4 flex items-center justify-end gap-2"
          aria-label="Shift history pages"
        >
          {pagination.page > 1 ? (
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  href={pageHref(
                    employee.id,
                    pagination.page - 1,
                    detail.period.start,
                    detail.period.end
                  )}
                />
              }
            >
              Previous
            </Button>
          ) : (
            <Button variant="outline" disabled>
              Previous
            </Button>
          )}
          {pagination.page < pagination.pages ? (
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  href={pageHref(
                    employee.id,
                    pagination.page + 1,
                    detail.period.start,
                    detail.period.end
                  )}
                />
              }
            >
              Next
            </Button>
          ) : (
            <Button variant="outline" disabled>
              Next
            </Button>
          )}
        </nav>
      ) : null}
    </Page>
  )
}
