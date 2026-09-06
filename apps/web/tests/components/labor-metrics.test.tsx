// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { LaborMetrics } from "@/components/labor/labor-metrics"
import type { Comparison } from "@/components/period-filter"

afterEach(cleanup)

function renderMetrics(comparison: Comparison) {
  return render(
    <LaborMetrics
      laborCostCents={8500}
      priorLaborCostCents={16000}
      payrollTaxCents={0}
      totalSeconds={14400}
      priorTotalSeconds={28800}
      unpaidBreakSeconds={0}
      shiftCount={1}
      netSalesCents={50000}
      priorNetSalesCents={40000}
      currencyCode="USD"
      comparison={comparison}
    />
  )
}

describe("labor metrics comparison labels", () => {
  it("uses truthful neutral wording for the comparable-period mode", () => {
    renderMetrics("fifty_two_weeks_prior")

    expect(
      screen.getByLabelText("Labor cost vs previous comparable period")
    ).toBeTruthy()
    expect(
      screen.getByLabelText("Hours worked vs previous comparable period")
    ).toBeTruthy()
    expect(
      screen.getByText(/previous comparable period/, { selector: "p" })
    ).toBeTruthy()
    expect(screen.queryByText(/last year/)).toBeNull()
  })

  it("renders prior_year as the neutral previous-year comparison", () => {
    renderMetrics("prior_year")

    expect(screen.getByLabelText("Labor cost vs previous year")).toBeTruthy()
    // Distinct from the weekday-aligned mode, and no longer the over-claiming
    // "same date last year" that lied for ranges spanning 29 Feb.
    expect(screen.queryByText(/previous comparable period/)).toBeNull()
    expect(screen.queryByText(/same date last year/)).toBeNull()
  })

  it("calls prior_day the prior period, since a range compares against the prior period", () => {
    renderMetrics("prior_day")

    expect(screen.getByLabelText("Labor cost vs prior period")).toBeTruthy()
    expect(screen.getByLabelText("Hours worked vs prior period")).toBeTruthy()
    expect(screen.getByLabelText("Labor share vs prior period")).toBeTruthy()
    expect(screen.getByText(/prior period/, { selector: "p" })).toBeTruthy()
    expect(screen.queryByText(/prior day/)).toBeNull()
  })

  it("falls back to a neutral message when there is no baseline", () => {
    render(
      <LaborMetrics
        laborCostCents={8500}
        priorLaborCostCents={0}
        payrollTaxCents={0}
        totalSeconds={14400}
        priorTotalSeconds={0}
        unpaidBreakSeconds={0}
        shiftCount={2}
        netSalesCents={50000}
        priorNetSalesCents={null}
        currencyCode="USD"
        comparison="fifty_two_weeks_prior"
      />
    )

    expect(screen.getByText("Nothing to compare against")).toBeTruthy()
  })

  it("names the payroll burden and the all-in figure once a rate is set", () => {
    render(
      <LaborMetrics
        laborCostCents={8500}
        priorLaborCostCents={16000}
        payrollTaxCents={798}
        totalSeconds={14400}
        priorTotalSeconds={28800}
        unpaidBreakSeconds={0}
        shiftCount={1}
        netSalesCents={50000}
        priorNetSalesCents={40000}
        currencyCode="USD"
        comparison="fifty_two_weeks_prior"
      />
    )

    // The incremental and the loaded total, so neither has to be worked out
    // from the other. The figure on the card stays the wage.
    expect(screen.getByText(/\+ \$8 payroll tax · \$93 all in/)).toBeTruthy()
    expect(screen.getByText("$85")).toBeTruthy()
  })

  it("names the unpaid break beside the clocked hours", () => {
    render(
      <LaborMetrics
        laborCostCents={8500}
        priorLaborCostCents={16000}
        payrollTaxCents={0}
        totalSeconds={28800}
        priorTotalSeconds={28800}
        unpaidBreakSeconds={1800}
        shiftCount={2}
        netSalesCents={50000}
        priorNetSalesCents={40000}
        currencyCode="USD"
        comparison="fifty_two_weeks_prior"
      />
    )

    // Eight clocked hours stay the figure; the deduction is named beside
    // them rather than folded in.
    expect(screen.getByText("8.0")).toBeTruthy()
    expect(screen.getByText(/2 shifts · 0.5h unpaid break/)).toBeTruthy()
  })
})
