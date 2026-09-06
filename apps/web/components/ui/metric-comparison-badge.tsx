import { Badge } from "@/components/ui/badge"
import { formatSignedPercent } from "@/lib/format-delta"

/**
 * The delta pill next to a metric: signed percentage, green when the move is
 * the one you wanted and red when it is not. Direction alone decides nothing —
 * labor going up is bad, sales going up is good, so callers pass
 * `lowerIsBetter`.
 *
 * A period with no baseline gets **no pill**. The handoff draws a pill or it
 * draws nothing; "No prior" was invented in the first pass and made Analytics
 * and Labor disagree, since Labor rendered nothing in the same case.
 */
export function MetricComparisonBadge({
  current,
  previous,
  lowerIsBetter = false,
  label,
}: {
  current: number
  previous: number
  lowerIsBetter?: boolean
  /** What the pill announces, e.g. "Net sales against the prior week". */
  label?: string
}) {
  if (!previous) return null

  const change = (current - previous) / Math.abs(previous)
  const isFavorable = lowerIsBetter ? change <= 0 : change >= 0

  return (
    <Badge
      aria-label={label}
      variant={isFavorable ? "success" : "destructive"}
      className="whitespace-nowrap"
    >
      {formatSignedPercent(change)}
    </Badge>
  )
}
