"use client"

import * as React from "react"

import { salesIdentityLines } from "@/app/(app)/products/actions"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TableFrame } from "@/components/ui/table"
import type { SalesIdentityLine, SalesReviewItem } from "@/lib/backend/types"
import { formatCents, quantityFormat } from "@/lib/money"
import { channelLabel } from "@/lib/sales-identity"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/datetime"

const GRID =
  "grid-cols-[136px_minmax(0,1fr)_56px_88px_88px_100px] gap-3 min-w-[640px]"

function lineMeta(line: SalesIdentityLine): string {
  return [line.location, line.orderSource, line.employeeName]
    .filter(Boolean)
    .join(" · ")
}

export function IdentityLinesDialog({
  item,
  onOpenChange,
}: {
  item: SalesReviewItem
  onOpenChange: (open: boolean) => void
}) {
  const [lines, setLines] = React.useState<SalesIdentityLine[] | null>(null)
  const [lineCount, setLineCount] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void salesIdentityLines({
      channel: item.channel,
      providerAccountId: item.providerAccountId,
      matchKey: item.matchKey,
    }).then((result) => {
      if (cancelled) return
      if ("error" in result) {
        setError(result.error)
        return
      }
      setLines(result.items)
      setLineCount(result.lineCount)
    })
    return () => {
      cancelled = true
    }
  }, [item])

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {item.itemName}
            {item.externalVariantTitle ? ` · ${item.externalVariantTitle}` : ""}
          </DialogTitle>
          <DialogDescription>
            {[channelLabel(item.channel), item.sku].filter(Boolean).join(" · ")}{" "}
            — the most recent sales recorded for this item.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-base text-destructive">
            {error}
          </p>
        ) : (
          <TableFrame>
            <div className="overflow-x-auto">
              <div
                className={cn(
                  "grid h-11 items-center border-b border-border px-3.5 text-2xs font-medium text-ink-soft",
                  GRID
                )}
              >
                <span>Date</span>
                <span>Order</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Gross</span>
                <span className="text-right">Discount</span>
                <span className="text-right">Net</span>
              </div>
              {lines === null ? (
                <p className="px-3.5 py-6 text-center text-base text-muted-foreground">
                  Loading…
                </p>
              ) : lines.length === 0 ? (
                <p className="px-3.5 py-6 text-center text-base text-muted-foreground">
                  No sales recorded yet — this item came from the provider
                  catalog.
                </p>
              ) : (
                lines.map((line) => (
                  <div
                    key={line.id}
                    className={cn(
                      "grid items-center border-b border-muted px-3.5 py-2 last:border-b-0",
                      GRID
                    )}
                  >
                    <span className="text-base text-muted-foreground tabular-nums">
                      {/* In the zone the sale was recorded in. */}
                      {formatDateTime(line.soldAt, line.timezone)}
                    </span>
                    <span className="min-w-0">
                      <span
                        className="block truncate text-base text-foreground"
                        title={line.externalOrderId}
                      >
                        {line.externalOrderId || "—"}
                      </span>
                      {lineMeta(line) ? (
                        <span
                          className="mt-0.5 block truncate text-xs text-faint"
                          title={lineMeta(line)}
                        >
                          {lineMeta(line)}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-right text-base text-muted-foreground tabular-nums">
                      {quantityFormat.format(line.quantity)}
                    </span>
                    <span className="text-right text-base text-muted-foreground tabular-nums">
                      {formatCents(line.grossCents, line.currencyCode)}
                    </span>
                    <span className="text-right text-base text-muted-foreground tabular-nums">
                      {formatCents(line.discountCents, line.currencyCode)}
                    </span>
                    <span className="text-right tabular-nums">
                      <span className="block text-base text-foreground">
                        {formatCents(line.netSalesCents, line.currencyCode)}
                      </span>
                      {line.refundCents ? (
                        <span className="mt-0.5 block text-xs text-faint">
                          refund{" "}
                          {formatCents(line.refundCents, line.currencyCode)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))
              )}
            </div>
          </TableFrame>
        )}

        {lines !== null && lineCount > lines.length ? (
          <p className="text-xs text-faint">
            Showing the {lines.length} most recent of {lineCount} sales.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
