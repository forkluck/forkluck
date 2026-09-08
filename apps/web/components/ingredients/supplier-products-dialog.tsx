"use client"

import * as React from "react"

import { setPreferredSupplierItem } from "@/app/(app)/ingredients/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useCommit } from "@/hooks/use-commit"
import { formatCents } from "@/lib/money"
import type { IngredientRow } from "@/lib/backend/types"
import { preferredWeightUnit } from "@/lib/business-settings"
import { cheaperSupplierItem } from "@/lib/ingredient-insights"
import type { SaveFailure } from "@/lib/save-failure"
import { formatUnitPrice } from "@/lib/pricing"
import { formatCalendarDate } from "@/lib/datetime"

function sourceLabel(value: string) {
  return value.replace(/^./, (letter) => letter.toUpperCase())
}

/**
 * Every pack a supplier sells this ingredient in. Recipes cost from the
 * preferred one, so this is where that choice is made; the rest stay attached
 * with their supplier IDs and prices.
 */
export function SupplierProductsDialog({
  ingredient,
  open,
  onOpenChange,
}: {
  ingredient: IngredientRow
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const { currencyCode, measurementSystem } = useBusinessSettings()
  const unitPriceUnit = preferredWeightUnit(measurementSystem)
  const [chosenId, setChosenId] = React.useState<string | null>(null)
  const [failure, setFailure] = React.useState<SaveFailure | null>(null)
  const cheaper = cheaperSupplierItem(ingredient)
  const commit = useCommit({})

  // The pack the workspace costs from, moved before the server answers.
  const isPreferred = (item: IngredientRow["supplierItems"][number]) =>
    chosenId === null ? item.isPreferred : chosenId === item.id

  const choose = (id: string) => {
    const previous = chosenId
    void commit({
      domain: `ingredient:${ingredient.id}:preferred-pack`,
      apply: () => setChosenId(id),
      revert: () => setChosenId(previous),
      write: () => setPreferredSupplierItem(id),
    }).then(setFailure)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Supplier packs</DialogTitle>
          <DialogDescription>
            {ingredient.name} is costed from the preferred pack. Every other
            pack stays attached with its supplier ID.
          </DialogDescription>
        </DialogHeader>

        {cheaper ? (
          <div className="rounded-lg border border-warning-border bg-warning-fill px-3.5 py-2.5 text-base leading-[1.55] text-warning-foreground">
            {sourceLabel(cheaper.item.supplier)} {cheaper.item.externalId} is
            about {Math.round(cheaper.savingsPercent)}% less per {unitPriceUnit}
            .
          </div>
        ) : null}

        <div className="max-h-[55dvh] divide-y divide-muted overflow-auto rounded-xl border border-border">
          {ingredient.supplierItems.map((item) => (
            <div key={item.id} className="flex items-center gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-md">{item.title}</span>
                  {isPreferred(item) ? (
                    <Badge className="rounded-sm px-[7px] py-0.5 text-2xs">
                      Preferred
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-xs text-faint">
                  {sourceLabel(item.supplier)} {item.externalId} ·{" "}
                  {item.rawSize} ·{" "}
                  {formatCents(item.packPriceCents, currencyCode)} ·{" "}
                  {formatUnitPrice(
                    item.packPriceCents,
                    item.packAmount,
                    item.packUnit,
                    unitPriceUnit,
                    currencyCode
                  )}{" "}
                  / {unitPriceUnit}
                </p>
                {item.periodEnd ? (
                  <p className="mt-0.5 truncate text-xs text-faint">
                    Price through {formatCalendarDate(item.periodEnd)}
                  </p>
                ) : null}
              </div>
              {isPreferred(item) ? (
                <span className="shrink-0 text-xs text-faint">
                  Used for costing
                </span>
              ) : (
                <Button variant="outline" onClick={() => choose(item.id)}>
                  Use this pack
                </Button>
              )}
            </div>
          ))}
        </div>
        {failure ? (
          <p className="text-xs text-destructive" role="alert">
            {failure.message}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
