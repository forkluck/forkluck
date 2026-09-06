"use client"

import { useBusinessSettings } from "@/components/business-settings-provider"
import { formatFullDate } from "@/lib/datetime"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableFrame,
  TableHead,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table"
import { formatCents } from "@/lib/money"
import { formatPackSize } from "@/lib/unit-registry"
import type { IngredientRow } from "@/lib/backend/types"

export function PriceHistoryDialog({
  open,
  onOpenChange,
  history,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  history: IngredientRow["priceHistory"]
}) {
  const { currencyCode, measurementSystem, timezone } = useBusinessSettings()
  const newestFirst = [...history].sort(
    (left, right) => right.effectiveAt.getTime() - left.effectiveAt.getTime()
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Price history</DialogTitle>
        </DialogHeader>
        <TableFrame className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableHeaderRow>
                <TableHead className="pl-3.5">Date</TableHead>
                <TableHead className="w-28">Pack</TableHead>
                <TableHead className="w-24 text-right">Price</TableHead>
              </TableHeaderRow>
            </TableHeader>
            <TableBody>
              {newestFirst.length === 0 ? (
                <TableEmpty colSpan={3}>
                  No price changes recorded yet.
                </TableEmpty>
              ) : (
                newestFirst.map((price) => (
                  <TableRow key={price.id}>
                    <TableCell className="pl-3.5">
                      {formatFullDate(price.effectiveAt, timezone)}
                    </TableCell>
                    <TableCell className="text-base text-muted-foreground">
                      {formatPackSize(
                        price.purchaseSize,
                        price.purchaseUnit,
                        measurementSystem
                      )}
                    </TableCell>
                    <TableCell className="pr-3.5 text-right tabular-nums">
                      {formatCents(price.purchaseCostCents, currencyCode)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableFrame>
      </DialogContent>
    </Dialog>
  )
}
