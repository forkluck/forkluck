import * as React from "react"

import { formatDecimalHours } from "@/components/labor/labor-format"
import { Badge } from "@/components/ui/badge"
import { MetricComparisonBadge } from "@/components/ui/metric-comparison-badge"
import { MetricCard } from "@/components/ui/metric-card"
import { comparisonNoun, type Comparison } from "@/lib/period-comparison"
import type { CurrencyCode } from "@/lib/business-settings"
import { formatSignedPoints } from "@/lib/format-delta"
import { formatWholeCents, percentFormat } from "@/lib/money"

/**
 * The three cards that open the Labor screen: what the period cost, how many
 * hours it took, and what share of net sales that is. Each card is the
 * handoff's plain object — 12px radius, one 1px hairline, no shadow — with a
 * label, a 26px figure, its delta pill, and one sub-line of context.
 */

export function LaborMetrics({
  laborCostCents,
  priorLaborCostCents,
  payrollTaxCents,
  totalSeconds,
  priorTotalSeconds,
  unpaidBreakSeconds,
  shiftCount,
  netSalesCents,
  priorNetSalesCents,
  currencyCode,
  comparison,
}: {
  laborCostCents: number
  priorLaborCostCents: number
  /** The employer burden on that wage; zero unless the workspace set a rate. */
  payrollTaxCents: number
  totalSeconds: number
  priorTotalSeconds: number
  /** What the unpaid-break rule took off; zero unless the rule is on. */
  unpaidBreakSeconds: number
  shiftCount: number
  netSalesCents: number | null
  priorNetSalesCents: number | null
  currencyCode: CurrencyCode
  comparison: Comparison
}) {
  // Every card measures against the same selected comparison, so name it once
  // and let the pills and notes say which one rather than a stale "prior
  // period" that lies when the comparison is a year back.
  const against = comparisonNoun(comparison)
  // Labor share is only a number when there were sales to divide by; an
  // unknown denominator prints as unknown rather than as zero percent.
  const salesAvailable = netSalesCents !== null
  const share =
    netSalesCents !== null && netSalesCents > 0
      ? laborCostCents / netSalesCents
      : null
  const priorShare =
    priorNetSalesCents !== null && priorNetSalesCents > 0
      ? priorLaborCostCents / priorNetSalesCents
      : null
  const pointChange =
    share !== null && priorShare !== null ? (share - priorShare) * 100 : null

  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-3">
      <MetricCard
        label="Labor cost"
        value={formatWholeCents(laborCostCents, currencyCode)}
        badge={
          <MetricComparisonBadge
            current={laborCostCents}
            previous={priorLaborCostCents}
            lowerIsBetter
            label={`Labor cost vs ${against}`}
          />
        }
        note={
          // A kitchen that set a payroll tax rate asked to see what it adds,
          // so the burden and the all-in figure take the sub-line ahead of
          // the comparison. The figure above stays wages either way: one
          // number, one meaning, whatever the rate is set to.
          payrollTaxCents
            ? `+ ${formatWholeCents(payrollTaxCents, currencyCode)} payroll tax · ${formatWholeCents(laborCostCents + payrollTaxCents, currencyCode)} all in`
            : priorLaborCostCents
              ? `${formatWholeCents(priorLaborCostCents, currencyCode)} ${against}`
              : "Nothing to compare against"
        }
      />
      <MetricCard
        label="Labor % of net sales"
        value={share === null ? "—" : percentFormat.format(share)}
        badge={
          pointChange === null ? null : (
            <Badge
              aria-label={`Labor share vs ${against}`}
              variant={pointChange <= 0 ? "success" : "destructive"}
              className="whitespace-nowrap"
            >
              {formatSignedPoints(pointChange)}
            </Badge>
          )
        }
        note={
          netSalesCents !== null && netSalesCents > 0
            ? `of ${formatWholeCents(netSalesCents, currencyCode)} net sales`
            : salesAvailable
              ? "No net sales in this period"
              : "Net sales unavailable"
        }
      />
      <MetricCard
        label="Hours worked"
        value={formatDecimalHours(totalSeconds)}
        badge={
          <MetricComparisonBadge
            current={totalSeconds}
            previous={priorTotalSeconds}
            lowerIsBetter
            label={`Hours worked vs ${against}`}
          />
        }
        note={
          // Clocked hours are the figure; what the break rule took off is
          // named beside them rather than silently folded in.
          unpaidBreakSeconds
            ? `${shiftCount === 1 ? "1 shift" : `${shiftCount} shifts`} · ${formatDecimalHours(unpaidBreakSeconds)}h unpaid break`
            : shiftCount === 1
              ? "1 shift"
              : `${shiftCount} shifts`
        }
      />
    </div>
  )
}
