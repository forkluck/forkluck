"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { ForecastDateFilter } from "@/components/menus/forecast-date-filter"
import { LoadingRegion } from "@/components/ui/loading-region"
import { Toolbar, ToolbarSpacer } from "@/components/ui/page"
import { TabPill, TabPills } from "@/components/ui/tab-pills"
import type { MenuForecastPlan } from "@/lib/backend/types"

export type ForecastRange = { start: string; end: string }

/**
 * The forecast's URL: the selected dates and the plan. The defaults stay out
 * of it so the canonical forecast link is bare; a chosen range always
 * travels as both dates, so a shared link plans the same days.
 */
export function forecastHref(
  base: string,
  { range, plan }: { range: ForecastRange | null; plan: MenuForecastPlan }
) {
  const query = new URLSearchParams()
  if (range) {
    query.set("start", range.start)
    query.set("end", range.end)
  }
  if (plan === "busy") query.set("plan", "busy")
  const search = query.toString()
  return search ? `${base}?${search}` : base
}

/**
 * The screen's toolbar: the dates being planned for, the plan pills, then
 * the actions at the far end. The date pill opens the calendar; a chosen
 * range changes only the search params, which the router answers with no
 * loading screen of its own, so the tables dim until the new numbers arrive.
 * The whole row stays off the printed page.
 */
export function ForecastControls({
  base,
  range,
  selectedRange,
  timeZone,
  plan,
  actions,
  children,
}: {
  base: string
  /** The dates the forecast covers, as the backend resolved them. */
  range: ForecastRange
  /** The dates in the URL, or null when the page is on its default week. */
  selectedRange: ForecastRange | null
  timeZone: string
  plan: MenuForecastPlan
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const router = useRouter()
  const [datesPending, startDates] = React.useTransition()
  const [planPending, setPlanPending] = React.useState(false)
  const pending = datesPending || planPending
  return (
    <>
      <Toolbar className="print:hidden">
        <ForecastDateFilter
          selectedStartDate={range.start}
          selectedEndDate={range.end}
          timeZone={timeZone}
          pending={datesPending}
          onSelectedDateRangeChange={(start, end) =>
            startDates(() => {
              router.push(forecastHref(base, { range: { start, end }, plan }))
            })
          }
        />
        <ToolbarSpacer />
        <div className="flex flex-wrap items-center gap-2 md:contents">
          <span className="text-sm text-muted-foreground">Plan for</span>
          <TabPills
            aria-label="Plan"
            className="w-fit"
            onPendingChange={setPlanPending}
          >
            <TabPill
              active={plan === "typical"}
              render={
                <Link
                  href={forecastHref(base, {
                    range: selectedRange,
                    plan: "typical",
                  })}
                />
              }
            >
              Typical
            </TabPill>
            <TabPill
              active={plan === "busy"}
              render={
                <Link
                  href={forecastHref(base, {
                    range: selectedRange,
                    plan: "busy",
                  })}
                />
              }
            >
              Busy
            </TabPill>
          </TabPills>
          {actions}
        </div>
      </Toolbar>
      <LoadingRegion pending={pending} label="Loading forecast">
        {/* The region wraps its children in a column of its own, so the
            section rhythm has to sit inside it: 32px between the introduction
            and each table, the gap a screen of several blocks keeps. */}
        <div className="flex flex-col gap-8">{children}</div>
      </LoadingRegion>
    </>
  )
}
