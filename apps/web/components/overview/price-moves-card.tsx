import {
  ColumnLabel,
  ListBody,
  ListCard,
  ListCardEmpty,
  ListHeader,
  listRowClassName,
} from "@/components/overview/analytics-cards"
import { formatCents } from "@/lib/money"
import type { CurrencyCode } from "@/lib/business-settings"
import { formatSignedPercent } from "@/lib/format-delta"
import { unitShort } from "@/lib/unit-registry"
import { cn } from "@/lib/utils"

export type PriceMove = {
  id: string
  name: string
  /** Percent change in unit price since the last different price; +8.4 = 8.4%. */
  percent: number
  /** Price of one unit — the kitchen's weight unit, or the unit of sale. */
  unitPriceCents: number
  unit: string
}

/**
 * Ingredient price moves, biggest first. A rise costs the kitchen money, so it
 * is the red; a fall is the softer green used for a healthy state rather than
 * the destructive red of an action. Deltas share a fixed-width column so the
 * signs line up.
 */
export function PriceMovesCard({
  moves,
  currencyCode,
}: {
  moves: PriceMove[]
  currencyCode: CurrencyCode
}) {
  return (
    <ListCard title="Price moves">
      {moves.length ? (
        <>
          <ListHeader className="flex items-center">
            <ColumnLabel>Ingredient</ColumnLabel>
          </ListHeader>
          <ListBody>
            {moves.map((move) => (
              <div
                key={move.id}
                className={cn("flex justify-between", listRowClassName)}
              >
                <span className="min-w-0 truncate text-md leading-5">
                  {move.name}
                </span>
                <span className="flex flex-none items-baseline gap-3">
                  <span className="text-sm text-faint tabular-nums">
                    {formatCents(move.unitPriceCents, currencyCode)} /{" "}
                    {unitShort(move.unit)}
                  </span>
                  <span
                    className={cn(
                      "w-13 text-right text-sm font-medium tabular-nums",
                      move.percent > 0 ? "text-destructive" : "text-success"
                    )}
                  >
                    {formatSignedPercent(move.percent / 100)}
                  </span>
                </span>
              </div>
            ))}
          </ListBody>
        </>
      ) : (
        <ListCardEmpty>
          No ingredient price has moved yet. Changes appear here once an invoice
          or a manual edit updates a price.
        </ListCardEmpty>
      )}
    </ListCard>
  )
}
