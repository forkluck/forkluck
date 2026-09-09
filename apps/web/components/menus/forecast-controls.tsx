"use client"

import * as React from "react"
import Link from "next/link"

import { LoadingRegion } from "@/components/ui/loading-region"
import { TabPill, TabPills } from "@/components/ui/tab-pills"
import type { MenuForecastPlan } from "@/lib/backend/types"

/** The defaults stay out of the URL so the canonical forecast link is bare. */
export function forecastHref(
  base: string,
  { days, plan }: { days: 7 | 30; plan: MenuForecastPlan }
) {
  const query = new URLSearchParams()
  if (days === 30) query.set("days", "30")
  if (plan === "busy") query.set("plan", "busy")
  const search = query.toString()
  return search ? `${base}?${search}` : base
}

/**
 * The horizon and plan pills, the dates they cover, the page's actions, and
 * the forecast they switch. A pill changes only the search params, which the
 * router answers with no loading screen of its own, so the pills swap at the
 * click and the forecast below dims behind a spinner until the new numbers
 * arrive. The whole row stays off the printed page.
 */
export function ForecastControls({
  base,
  days,
  plan,
  horizon,
  actions,
  children,
}: {
  base: string
  days: 7 | 30
  plan: MenuForecastPlan
  /** "Sep 8 to Sep 14, 2026": the days the pills chose. */
  horizon: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const [horizonPending, setHorizonPending] = React.useState(false)
  const [planPending, setPlanPending] = React.useState(false)
  const pending = horizonPending || planPending
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          <TabPills
            aria-label="Forecast horizon"
            className="w-fit"
            onPendingChange={setHorizonPending}
          >
            <TabPill
              active={days === 7}
              render={<Link href={forecastHref(base, { days: 7, plan })} />}
            >
              Next 7 days
            </TabPill>
            <TabPill
              active={days === 30}
              render={<Link href={forecastHref(base, { days: 30, plan })} />}
            >
              Next 30 days
            </TabPill>
          </TabPills>
          <span className="text-sm text-muted-foreground">{horizon}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Plan for</span>
            <TabPills
              aria-label="Plan"
              className="w-fit"
              onPendingChange={setPlanPending}
            >
              <TabPill
                active={plan === "typical"}
                render={
                  <Link href={forecastHref(base, { days, plan: "typical" })} />
                }
              >
                Typical
              </TabPill>
              <TabPill
                active={plan === "busy"}
                render={
                  <Link href={forecastHref(base, { days, plan: "busy" })} />
                }
              >
                Busy
              </TabPill>
            </TabPills>
          </div>
          {actions}
        </div>
      </div>
      <LoadingRegion
        pending={pending}
        label="Loading forecast"
        className="flex flex-col gap-6"
      >
        {children}
      </LoadingRegion>
    </>
  )
}
