"use client"

import { ArrowRight, CalendarRange, ExternalLink } from "lucide-react"

import { GuardedLink } from "@/components/navigation-blocker"

import { Button } from "@/components/ui/button"
import type { RecipeCostDiff } from "@/lib/backend/types"
import { formatDateRangeLabel } from "@/lib/date-range-label"
import { formatSignedCents } from "@/lib/format-delta"
import { formatCents } from "@/lib/money"
import { formatFullDate } from "@/lib/datetime"
import { useBusinessSettings } from "@/components/business-settings-provider"

type Result = RecipeCostDiff & { omittedLines?: number }

function sideLabel(
  side: Result["lines"][number]["from"],
  currencyCode: string
) {
  if (!side || side.status === "noHistory") return "No history"
  if (side.status === "unpriceable" || side.costCents === null)
    return "Unpriceable"
  return formatCents(side.costCents, currencyCode)
}

export function PrimoResultCard({
  result,
  onSuggestion,
}: {
  result: Result
  onSuggestion: (message: string) => void
}) {
  const { timezone } = useBusinessSettings()
  const complete = result.totals.fromComplete && result.totals.toComplete
  const delta = complete
    ? result.totals.deltaCents
    : result.totals.comparableDeltaCents
  const changed = result.lines.filter(
    (line) => line.deltaCents !== null && line.deltaCents !== 0
  )
  const previous = result.lastChangeBeforeWindow
  const previousDate = previous ? previous.at.slice(0, 10) : null
  const emptyWindowLabel =
    result.window.source === "default90Days"
      ? "No price changes in the last 90 days."
      : "No price changes in this period."

  return (
    <section className="w-full rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3.5">
        <div className="mb-2 flex items-center gap-2 text-md leading-5 font-medium text-foreground">
          <CalendarRange className="size-3.5" aria-hidden="true" />
          <span>
            {formatDateRangeLabel(result.window.fromDate, result.window.toDate)}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {result.window.source === "default90Days"
              ? "Default 90 days"
              : `${result.window.days} days`}
          </span>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Price-only comparison using today&apos;s recipe quantities, yields,
          and conversions.
        </p>
      </div>

      <div className="px-4 py-4">
        {result.priceChangesInWindow === 0 ? (
          <div>
            <p className="font-heading text-lg leading-6 font-semibold text-foreground">
              {previous
                ? emptyWindowLabel
                : "No price changes in this period, and Forkluck has no earlier price history for this recipe."}
            </p>
            {previous ? (
              <p className="mt-1 text-md leading-5 text-muted-foreground">
                The most recent was{" "}
                {formatFullDate(new Date(previous.at), timezone)} —{" "}
                {previous.ingredient.name}.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-xs leading-4 font-medium text-muted-foreground">
                {complete ? "Recipe cost change" : "Comparable-line change"}
              </p>
              <p className="mt-1 font-heading text-2xl leading-8 font-semibold tracking-tight text-foreground">
                {delta === null
                  ? "Incomplete"
                  : formatSignedCents(delta, result.currencyCode)}
              </p>
            </div>
            {complete &&
            result.totals.fromCents !== null &&
            result.totals.toCents !== null ? (
              <p className="pb-1 text-xs leading-4 text-muted-foreground">
                {formatCents(result.totals.fromCents, result.currencyCode)}
                <ArrowRight className="mx-1 inline size-3" aria-hidden="true" />
                {formatCents(result.totals.toCents, result.currencyCode)}
              </p>
            ) : null}
          </div>
        )}

        {result.priceChangesInWindow > 0 && delta === 0 ? (
          <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
            {complete
              ? "Prices moved during the period, but the ending recipe cost returned to its starting value."
              : "Prices moved during the period, while the comparable priced lines ended at their starting cost."}
          </p>
        ) : null}

        {changed.length ? (
          <div className="mt-4 divide-y divide-border border-y border-border">
            {changed.map((line) => (
              <div key={line.itemId} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {line.ingredientPublicId ? (
                      <GuardedLink
                        href={`/ingredients/${line.ingredientPublicId}`}
                        className="font-medium text-foreground hover:underline hover:underline-offset-4"
                      >
                        {line.name}
                      </GuardedLink>
                    ) : (
                      <span className="font-medium text-foreground">
                        {line.name}
                      </span>
                    )}
                    <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
                      {sideLabel(line.from, result.currencyCode)} →{" "}
                      {sideLabel(line.to, result.currencyCode)}
                    </p>
                  </div>
                  <span className="shrink-0 text-md leading-5 font-medium text-foreground tabular-nums">
                    {formatSignedCents(line.deltaCents!, result.currencyCode)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {!complete ? (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            {result.coverage.skippedLines} required line
            {result.coverage.skippedLines === 1 ? " was" : "s were"} left out
            from the complete comparison because price history or conversion
            data is missing.
          </p>
        ) : null}
        {result.omittedLines ? (
          <p className="mt-2 text-xs leading-4 text-muted-foreground">
            {result.omittedLines} additional lines omitted from this summary.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {result.priceChangesInWindow === 0 && previous && previousDate ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                onSuggestion(
                  `Compare this recipe since ${formatFullDate(new Date(previous.at), timezone)}.`
                )
              }
            >
              Compare since {formatFullDate(new Date(previous.at), timezone)}
            </Button>
          ) : null}
          <Button
            render={
              <GuardedLink href={`/recipes/${result.recipe.publicId}/cost`} />
            }
            size="sm"
            variant="ghost"
          >
            Open Cost tab
            <ExternalLink data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  )
}
