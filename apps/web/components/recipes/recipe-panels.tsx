"use client"

import * as React from "react"
import { ChevronRight, Eye, EyeOff, TriangleAlert } from "lucide-react"

import { GuardedLink } from "@/components/navigation-blocker"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { PriceLineDialog } from "@/components/ingredients/price-line-dialog"
import type { PriceLineMatch } from "@/components/ingredients/price-line-dialog"
import { Badge } from "@/components/ui/badge"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { WarningLine } from "@/components/recipes/warning-line"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table"
import type { CostBreakdown } from "@/lib/benchcost/math"
import { formatCents, formatWholeCents } from "@/lib/money"
import type { PriceListEntry, PricedLine } from "@/lib/pricing"
import { formatScaledWeight } from "@/lib/recipe"
import type { ParsedRecipeLine } from "@/lib/recipe"
import {
  RECIPE_LINE_ALERT_LABELS,
  type RecipeLineAlert,
} from "@/lib/recipe/line-alert"
import {
  WEIGHT_UNITS,
  toGrams,
  type WeightSystem,
  type WeightUnit,
} from "@/lib/units"
import { cn } from "@/lib/utils"

const measureAmountFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 3,
})

/** A row the cook left without an amount ("olive oil, for brushing"). */
function isUnmeasured(line: ParsedRecipeLine): boolean {
  if (line.componentQuantity) return false
  if ((line.ingredient?.grams ?? 0) > 0) return false
  return !Number.isFinite(line.enteredAmount) || line.enteredAmount <= 0
}

/**
 * What a line contributes, in the measure the cook wrote. The resolved weight
 * follows it as a secondary reading rather than replacing it, so a row that
 * says "0.25 tsp" still says so once the density chart has priced it.
 */
function quantityLabel(
  line: ParsedRecipeLine,
  measurementSystem: WeightSystem
): { measure: string; equivalent: string | null } {
  if (isUnmeasured(line)) return { measure: "—", equivalent: null }

  const grams = line.ingredient?.grams ?? null
  if (line.componentQuantity) {
    return {
      measure: `${measureAmountFormat.format(line.componentQuantity.amount)} each`,
      equivalent: null,
    }
  }

  const normalized =
    line.normalizedUnit === "assumed-g" ? "g" : line.normalizedUnit
  // A line already written by weight is not restated as itself.
  if (normalized !== null && WEIGHT_UNITS.includes(normalized as WeightUnit)) {
    const unit = normalized as WeightUnit
    return {
      measure: formatScaledWeight(
        grams ?? toGrams(line.enteredAmount, unit),
        measurementSystem,
        { amount: line.enteredAmount, unit }
      ),
      equivalent: null,
    }
  }

  const measure = [
    measureAmountFormat.format(line.enteredAmount),
    line.enteredUnit ?? normalized,
  ]
    .filter(Boolean)
    .join(" ")
  return {
    measure,
    equivalent:
      grams !== null && grams > 0
        ? `≈ ${formatScaledWeight(grams, measurementSystem)}`
        : null,
  }
}

/** "30 min", "2 h", "1 h 30 min". */
function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function TotalRow({
  label,
  value,
  hint,
  valueHint,
  strong,
  divider,
  span,
  valueClass,
}: {
  label: string
  value: React.ReactNode
  /** Label columns to cover: everything left of the cost column. */
  span: number
  /** The cost column's own gutter, so rows and totals end on one line. */
  valueClass?: string
  /** Where the figure came from, under the label it belongs to. */
  hint?: string | null
  /** The same, under the figure: what the batch this costs amounts to. */
  valueHint?: string | null
  strong?: boolean
  /** Rules the totals off as a footer under the last ingredient. */
  divider?: boolean
}) {
  const edge = divider && "border-t border-border pt-4"
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={span}
        className={cn("text-base", strong && "font-medium", edge)}
      >
        {label}
        {hint ? (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </TableCell>
      <TableCell
        className={cn(
          "text-right text-base whitespace-nowrap tabular-nums",
          strong && "font-medium",
          edge,
          valueClass
        )}
      >
        {value}
        {valueHint ? (
          <span className="block text-xs font-normal text-muted-foreground">
            {valueHint}
          </span>
        ) : null}
      </TableCell>
    </TableRow>
  )
}

/**
 * What the batch costs, line by line, and where the partial figures come from.
 * The ingredients themselves are edited on the Recipe tab; what a line is
 * priced from, and whether it counts at all, are settled here.
 */
export function RecipeCostingPanel({
  lines,
  lineKinds = [],
  priced,
  totalCents,
  yieldAmount,
  yieldWord,
  labor,
  priceList,
  onLinked,
  fixUnitHref,
  canPrice = true,
  onToggleLeftOut,
}: {
  lines: ParsedRecipeLine[]
  /** Saved row identity; parsing display text must not decide this badge. */
  lineKinds?: Array<"ingredient" | "subrecipe">
  priced: PricedLine[]
  /** The authoritative unrounded batch cost; money rounds once for display. */
  totalCents: number
  /** The scaled recipe yield that the per-unit row divides by. */
  yieldAmount: number | null
  /** What one unit of that yield is called: "slice", "piece", "gram". */
  yieldWord?: string | null
  labor: CostBreakdown | null
  priceList: PriceListEntry[]
  onLinked: (match: PriceLineMatch) => void
  fixUnitHref?: string
  /** False where this reader cannot change what a line is priced from. */
  canPrice?: boolean
  /** Given only where the reader may leave a line out of the money. */
  onToggleLeftOut?: (index: number, leftOut: boolean) => void
}) {
  const { currencyCode, measurementSystem, wagePerHourCents } =
    useBusinessSettings()
  // Which row has the price picker open, so a line costed against the wrong
  // match can be re-pointed here rather than only from the ingredient screen.
  const [pickerLine, setPickerLine] = React.useState<number | null>(null)
  const units = yieldAmount
  const laborCents = labor?.laborCentsPerBatch ?? 0
  // A whole wage reads as "$20/h", one with cents keeps them.
  const rate =
    wagePerHourCents % 100 === 0
      ? formatWholeCents(wagePerHourCents, currencyCode)
      : formatCents(wagePerHourCents, currencyCode)
  const timed = labor?.timedActiveStepCount ?? 0
  const laborHint =
    labor === null || labor.laborSecondsPerBatch === null
      ? null
      : labor.laborSource === "prep"
        ? `${formatDuration(labor.laborSecondsPerBatch)} at ${rate}/h`
        : `${formatDuration(labor.laborSecondsPerBatch)} from ${timed} timed step${timed === 1 ? "" : "s"}`
  // Rows round independently for display, while totals retain the same full
  // precision used everywhere else on the cost page and round only at output.
  const lineCents = priced.map((line) =>
    line.costCents === null ? null : Math.round(line.costCents)
  )
  const ingredientCents = totalCents
  const batchCents = ingredientCents + laborCents
  const leftOutCount = lines.filter(
    (line) => line.excludedFromCost === true
  ).length
  const untimed = labor?.untimedActiveStepCount ?? 0
  // The name column stays put while the rest scrolls; the hairline on its
  // edge only shows once the table has actually scrolled.
  const [scrolled, setScrolled] = React.useState(false)
  const pinned = cn(
    "sticky left-0 z-[1] bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:content-['']",
    scrolled ? "after:bg-border" : "after:bg-transparent"
  )
  // The row `…` overlays the cost column's right gutter instead of holding a
  // column of its own: the rows sum to the totals below them, so the two
  // columns of money have to end on the same line.
  const totalSpan = 3
  // `last:` because cost is the last column, over the frame's own `last:pr-0`.
  const costGutter = onToggleLeftOut ? "last:pr-9" : ""
  const yieldHint =
    units && units > 0 && yieldWord
      ? `${measureAmountFormat.format(units)} ${yieldWord}${units === 1 ? "" : "s"}`
      : null

  if (lines.length === 0) {
    return (
      <p className="text-base text-muted-foreground">
        Add ingredients on the Recipe tab and their cost lands here.
      </p>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <TableFrame
        className="overflow-x-auto"
        onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 0)}
      >
        <Table>
          <TableHeader>
            <TableHeaderRow className="h-11">
              <TableHead className={cn("w-full max-w-0 min-w-[180px]", pinned)}>
                Ingredient
              </TableHead>
              <TableHead className="w-8 pl-0">
                <span className="sr-only">Flags</span>
              </TableHead>
              <TableHead className="w-[130px] pr-8 text-right">Qty</TableHead>
              <TableHead className={cn("w-[120px] text-right", costGutter)}>
                Cost
              </TableHead>
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {lines.map((line, index) => {
              const costCents = lineCents[index] ?? null
              const quantity = quantityLabel(line, measurementSystem)
              // The entry this line is already matched to. The search has
              // been answered by the recipe, so the cell prices that match.
              const linked =
                priceList.find(
                  (entry) => entry.id === priced[index]?.ingredientId
                ) ?? null
              const pricedLine = priced[index] ?? null
              const linkedHasPrice = Boolean(
                linked?.purchaseUnit && (linked.purchaseSize ?? 0) > 0
              )
              const leftOut = line.excludedFromCost === true
              const alert: RecipeLineAlert | null =
                costCents !== null
                  ? null
                  : pricedLine?.needsConversion && linkedHasPrice
                    ? "no-conversion"
                    : "no-price"
              const alertLabel =
                alert === "no-conversion"
                  ? `${linked?.name ?? line.ingredientName} is not measured in ${line.enteredUnit ?? "that unit"}. Change the recipe quantity or set a conversion on the ingredient.`
                  : alert
                    ? RECIPE_LINE_ALERT_LABELS[alert]
                    : ""
              return (
                <TableRow key={line.lineNumber} className="h-11">
                  <TableCell
                    className={cn(
                      "max-w-0 group-hover/row:bg-fill-soft",
                      pinned
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2 text-md">
                      <span className="min-w-0 truncate">
                        {line.ingredientName}
                      </span>
                      {lineKinds[index] === "subrecipe" ? (
                        <Badge variant="secondary" size="row">
                          Recipe
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="w-8 pl-0">
                    {alert && !leftOut && !isUnmeasured(line) ? (
                      // The same flag a recipe line gets, in its own column
                      // so every flag sits on one line down the table.
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span
                              role="img"
                              aria-label={alertLabel}
                              className="flex size-5 items-center justify-center rounded-md text-warning"
                            />
                          }
                        >
                          <TriangleAlert
                            className="size-[13px]"
                            strokeWidth={2}
                            aria-hidden="true"
                          />
                        </TooltipTrigger>
                        <TooltipContent>{alertLabel}</TooltipContent>
                      </Tooltip>
                    ) : null}
                  </TableCell>
                  <TableCell className="pr-8 text-right text-base whitespace-nowrap text-muted-foreground tabular-nums">
                    <span className="block">{quantity.measure}</span>
                    {quantity.equivalent ? (
                      <span className="block text-xs text-muted-foreground/80">
                        {quantity.equivalent}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "relative text-right text-base whitespace-nowrap tabular-nums",
                      costGutter
                    )}
                  >
                    {/* The money is itself the way back into the picker, so a
                        line costed against the wrong match can be re-pointed
                        without waiting for an alert. A reader who cannot
                        re-point it still gets told the column is short. */}
                    {leftOut ? (
                      <span className="text-muted-foreground">Left out</span>
                    ) : alert === "no-conversion" ? (
                      fixUnitHref ? (
                        <GuardedLink
                          href={fixUnitHref}
                          className="inline-flex items-center text-primary underline-offset-4 hover:underline"
                        >
                          Open UOM
                          <ChevronRight
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        </GuardedLink>
                      ) : (
                        <span className="text-muted-foreground">
                          Unit mismatch
                        </span>
                      )
                    ) : canPrice ? (
                      <>
                        <button
                          type="button"
                          title="Replace where this price comes from"
                          onClick={() => setPickerLine(line.lineNumber)}
                          className={cn(
                            "underline-offset-4 hover:underline",
                            costCents === null && "text-primary"
                          )}
                        >
                          {costCents === null
                            ? "Add price"
                            : formatCents(costCents, currencyCode)}
                        </button>
                        <PriceLineDialog
                          lineName={line.ingredientName}
                          priceList={priceList}
                          linked={linked}
                          onLinked={onLinked}
                          trigger={null}
                          open={pickerLine === line.lineNumber}
                          onOpenChange={(next) =>
                            setPickerLine(next ? line.lineNumber : null)
                          }
                        />
                      </>
                    ) : costCents === null ? (
                      <span className="text-muted-foreground">
                        No price yet
                      </span>
                    ) : (
                      formatCents(costCents, currencyCode)
                    )}
                    {/* Sits in the gutter, out of the money's line, and only
                        shows itself once the row is hovered or focused. */}
                    {onToggleLeftOut ? (
                      <span className="absolute top-1/2 right-0 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 has-data-popup-open:opacity-100">
                        <RowActionsMenu
                          label={`Actions for ${line.ingredientName || "row"}`}
                        >
                          <MenuItem
                            onClick={() => onToggleLeftOut(index, !leftOut)}
                          >
                            {leftOut ? (
                              <>
                                <Eye strokeWidth={1.8} aria-hidden="true" />
                                Count in cost
                              </>
                            ) : (
                              <>
                                <EyeOff strokeWidth={1.8} aria-hidden="true" />
                                Leave out of cost
                              </>
                            )}
                          </MenuItem>
                        </RowActionsMenu>
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
            <TotalRow
              span={totalSpan}
              valueClass={costGutter}
              label="Ingredient cost / batch"
              value={formatCents(ingredientCents, currencyCode)}
              hint={
                leftOutCount
                  ? `${leftOutCount} line${leftOutCount === 1 ? "" : "s"} left out`
                  : null
              }
              strong
              divider
            />
            <TotalRow
              span={totalSpan}
              valueClass={costGutter}
              label="Labor / batch"
              value={
                labor === null || labor.laborCentsPerBatch === null ? (
                  <span className="text-muted-foreground">
                    {labor?.laborSource === "steps"
                      ? "No timed steps"
                      : "No prep time"}
                  </span>
                ) : (
                  formatCents(labor.laborCentsPerBatch, currencyCode)
                )
              }
              hint={laborHint}
            />
            <TotalRow
              span={totalSpan}
              valueClass={costGutter}
              label="Cost / batch"
              value={formatCents(batchCents, currencyCode)}
              valueHint={yieldHint}
              strong
            />
            {units && units > 0 ? (
              <TotalRow
                span={totalSpan}
                valueClass={costGutter}
                label={`Cost per ${yieldWord ?? "unit"}`}
                value={formatCents(
                  Math.round(batchCents / units),
                  currencyCode
                )}
                strong
              />
            ) : (
              <TotalRow
                span={totalSpan}
                valueClass={costGutter}
                label="Cost per yield"
                value={
                  <span className="inline-flex items-center justify-end gap-1.5">
                    <span className="text-muted-foreground">—</span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            role="img"
                            aria-label="Total yield needed for cost per yield"
                            className="flex size-5 items-center justify-center rounded-md text-warning"
                          />
                        }
                      >
                        <TriangleAlert
                          className="size-[13px]"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        Set a total yield on the Recipe tab to calculate cost
                        per unit and use this recipe as a sub-recipe.
                      </TooltipContent>
                    </Tooltip>
                  </span>
                }
                strong
              />
            )}
          </TableBody>
        </Table>
      </TableFrame>

      {untimed > 0 && labor?.laborSource === "steps" ? (
        <WarningLine>
          {`${untimed} step${untimed === 1 ? " is" : "s are"} untimed, so this cost is partial`}
        </WarningLine>
      ) : null}
    </div>
  )
}
