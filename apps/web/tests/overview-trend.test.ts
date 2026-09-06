import { describe, expect, it } from "vitest"

import {
  hasPrimeCostComparison,
  periodNetSales,
  primeCostState,
  trendBars,
} from "../components/overview/trend"
import type { NetSalesTrend } from "../lib/backend/types"

function day(
  date: string,
  currentSquareCents: number,
  currentShopifyCents: number,
  previousSquareCents = 0,
  previousShopifyCents = 0
) {
  return {
    date,
    currentSquareCents,
    currentShopifyCents,
    currentManualCents: 0,
    previousSquareCents,
    previousShopifyCents,
    previousManualCents: 0,
  }
}

const trend: NetSalesTrend = {
  currentDate: "2026-08-09",
  previousDate: "2026-08-02",
  comparisonDate: "2026-08-02",
  periodStart: "2026-08-03",
  periodEnd: "2026-08-05",
  comparisonStart: "2026-07-27",
  comparisonEnd: "2026-07-29",
  granularity: "day",
  currencyCode: "USD",
  comparison: "prior_day",
  availableDates: ["2026-08-09"],
  timezone: "UTC",
  financials: {
    currentLaborCents: 0,
    previousLaborCents: 0,
    currentInvoiceCents: 0,
    previousInvoiceCents: 0,
    currentInvoiceCount: 0,
    previousInvoiceCount: 0,
  },
  hours: [],
  days: [
    day("2026-08-03", 1_000, 500, 900, 100),
    day("2026-08-04", 2_000, 0, 1_000, 0),
    day("2026-08-05", 300, 200, 100, 0),
  ],
}

function dateAfter(start: string, offset: number) {
  const date = new Date(`${start}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function longTrend(start: string, count: number): NetSalesTrend {
  return {
    ...trend,
    days: Array.from({ length: count }, (_, index) =>
      day(dateAfter(start, index), 100 + index, 25, 50 + index, 10)
    ),
  }
}

function totalForDays(
  days: NetSalesTrend["days"],
  period: "current" | "previous"
) {
  return days.reduce(
    (total, point) =>
      total +
      point[`${period}SquareCents`] +
      point[`${period}ShopifyCents`] +
      point[`${period}ManualCents`],
    0
  )
}

describe("trend bars", () => {
  it("labels one bar per day and sums both channels by default", () => {
    expect(trendBars(trend, "all").map((bar) => bar.label)).toEqual([
      "Mon",
      "Tue",
      "Wed",
    ])
    expect(trendBars(trend, "all").map((bar) => bar.currentCents)).toEqual([
      1_500, 2_000, 500,
    ])
  })

  it("narrows both periods to the selected channel", () => {
    expect(periodNetSales(trend, "shopify")).toEqual({
      currentCents: 700,
      previousCents: 100,
    })
    expect(periodNetSales(trend, "all")).toEqual({
      currentCents: 4_000,
      previousCents: 2_100,
    })
  })

  it("includes manual ledger revenue only in the all-channel total", () => {
    const manualTrend: NetSalesTrend = {
      ...trend,
      days: trend.days.map((point, index) => ({
        ...point,
        currentManualCents: index === 0 ? 700 : 0,
      })),
    }

    expect(periodNetSales(manualTrend, "all").currentCents).toBe(4_700)
    expect(periodNetSales(manualTrend, "square").currentCents).toBe(3_300)
    expect(periodNetSales(manualTrend, "shopify").currentCents).toBe(700)
  })

  it("aggregates ranges over 31 days into seven-day bars without losing sales", () => {
    const longRange = longTrend("2026-08-01", 35)
    const bars = trendBars(longRange, "all")

    expect(bars.map((bar) => bar.label)).toEqual([
      "Aug 1",
      "Aug 8",
      "Aug 15",
      "Aug 22",
      "Aug 29",
    ])
    expect(bars[0]).toMatchObject({
      tooltipLabel: "Aug 1 – Aug 7",
      currentCents: 896,
      previousCents: 441,
    })
    expect(periodNetSales(longRange, "all")).toEqual({
      currentCents: totalForDays(longRange.days, "current"),
      previousCents: totalForDays(longRange.days, "previous"),
    })
  })

  it("aggregates ranges over 182 days into calendar-month bars without losing sales", () => {
    const longRange = longTrend("2025-12-01", 183)
    const bars = trendBars(longRange, "all")

    expect(bars.map((bar) => bar.label)).toEqual([
      "Dec",
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
    ])
    expect(bars[0]).toMatchObject({
      tooltipLabel: "December 2025",
      currentCents: 4_340,
      previousCents: 2_325,
    })
    expect(bars.at(-1)).toMatchObject({
      tooltipLabel: "June 2026",
      currentCents: 307,
      previousCents: 242,
    })
    expect(periodNetSales(longRange, "all")).toEqual({
      currentCents: totalForDays(longRange.days, "current"),
      previousCents: totalForDays(longRange.days, "previous"),
    })
  })
})

describe("prime cost dashboard state", () => {
  it("keeps prime cost incomplete when the selected period has no invoices", () => {
    expect(
      primeCostState({
        currentLaborCents: 37_398,
        previousLaborCents: 28_000,
        currentInvoiceCents: 0,
        previousInvoiceCents: 12_000,
        currentInvoiceCount: 0,
        previousInvoiceCount: 1,
      })
    ).toEqual({ status: "incomplete", laborCents: 37_398 })
  })

  it("estimates prime cost from labor and invoice purchases when invoices exist", () => {
    expect(
      primeCostState({
        currentLaborCents: 37_398,
        previousLaborCents: 28_000,
        currentInvoiceCents: 12_000,
        previousInvoiceCents: 9_000,
        currentInvoiceCount: 1,
        previousInvoiceCount: 1,
      })
    ).toEqual({ status: "estimated", currentCents: 49_398 })
  })

  it("only compares prime cost when both periods have invoices", () => {
    expect(
      hasPrimeCostComparison({
        currentLaborCents: 37_398,
        previousLaborCents: 28_000,
        currentInvoiceCents: 12_000,
        previousInvoiceCents: 0,
        currentInvoiceCount: 1,
        previousInvoiceCount: 0,
      })
    ).toBe(false)

    expect(
      hasPrimeCostComparison({
        currentLaborCents: 37_398,
        previousLaborCents: 28_000,
        currentInvoiceCents: 12_000,
        previousInvoiceCents: 9_000,
        currentInvoiceCount: 1,
        previousInvoiceCount: 1,
      })
    ).toBe(true)
  })
})
