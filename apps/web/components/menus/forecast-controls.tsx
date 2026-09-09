"use client"

import * as React from "react"
import Link from "next/link"

import { LoadingRegion } from "@/components/ui/loading-region"
import { Toolbar, ToolbarSpacer } from "@/components/ui/page"
import { TabPill, TabPills } from "@/components/ui/tab-pills"
import type { MenuForecastPlan } from "@/lib/backend/types"

export type ForecastView = "week" | "day"

/** The defaults stay out of the URL so the canonical forecast link is bare. */
export function forecastHref(
  base: string,
  {
    days,
    plan,
    view = "week",
  }: { days: 7 | 30; plan: MenuForecastPlan; view?: ForecastView }
) {
  const query = new URLSearchParams()
  if (days === 30) query.set("days", "30")
  if (plan === "busy") query.set("plan", "busy")
  if (view === "day") query.set("view", "day")
  const search = query.toString()
  return search ? `${base}?${search}` : base
}

/**
 * The screen's toolbar: horizon pills and the dates they chose, the plan
 * pills, then the actions at the far end, on the same 8px rhythm and 16px
 * drop every other toolbar keeps. A pill changes only the search params,
 * which the router answers with no loading screen of its own, so the pills
 * swap at the click and the forecast below dims behind a spinner until the
 * new numbers arrive. The whole row stays off the printed page.
 */
export function ForecastControls({
  base,
  days,
  plan,
  horizon,
  view = "week",
  actions,
  children,
}: {
  base: string
  days: 7 | 30
  plan: MenuForecastPlan
  /** "Sep 8 to Sep 14, 2026": the days the pills chose. */
  horizon: string
  view?: ForecastView
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const [horizonPending, setHorizonPending] = React.useState(false)
  const [planPending, setPlanPending] = React.useState(false)
  const [viewPending, setViewPending] = React.useState(false)
  const pending = horizonPending || planPending || viewPending
  return (
    <>
      <Toolbar className="print:hidden">
        <div className="flex flex-wrap items-center gap-2 md:contents">
          <TabPills
            aria-label="Forecast horizon"
            className="w-fit"
            onPendingChange={setHorizonPending}
          >
            <TabPill
              active={days === 7}
              render={
                <Link href={forecastHref(base, { days: 7, plan, view })} />
              }
            >
              Next 7 days
            </TabPill>
            <TabPill
              active={days === 30}
              render={
                <Link href={forecastHref(base, { days: 30, plan, view })} />
              }
            >
              Next 30 days
            </TabPill>
          </TabPills>
          <span className="text-sm text-muted-foreground">{horizon}</span>
        </div>
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
                  href={forecastHref(base, { days, plan: "typical", view })}
                />
              }
            >
              Typical
            </TabPill>
            <TabPill
              active={plan === "busy"}
              render={
                <Link href={forecastHref(base, { days, plan: "busy", view })} />
              }
            >
              Busy
            </TabPill>
          </TabPills>
          <TabPills
            aria-label="Forecast view"
            className="w-fit"
            onPendingChange={setViewPending}
          >
            <TabPill
              active={view === "week"}
              render={
                <Link href={forecastHref(base, { days, plan, view: "week" })} />
              }
            >
              Week
            </TabPill>
            <TabPill
              active={view === "day"}
              render={
                <Link href={forecastHref(base, { days, plan, view: "day" })} />
              }
            >
              Day
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
