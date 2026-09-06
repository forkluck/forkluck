"use client"

import * as React from "react"
import { ChevronDown, ChevronsUpDown, ChevronUp, Plus, X } from "lucide-react"

import { useBusinessSettings } from "@/components/business-settings-provider"
import {
  PriceLineDialog,
  type PriceLineMatch,
} from "@/components/ingredients/price-line-dialog"
import { AlertFlag } from "@/components/menu/product-cells"
import { Badge } from "@/components/ui/badge"
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
import { Spinner } from "@/components/ui/spinner"
import {} from "@/components/ui/tooltip"
import { preferredWeightUnit } from "@/lib/business-settings"
import {
  formatUnitPrice,
  type PriceListEntry,
  type PricedLine,
} from "@/lib/pricing"
import { rankedIngredientMatches } from "@/lib/search"
import {
  RECIPE_LINE_ALERT_LABELS,
  parseRecipeText,
  recipeLineAlert,
  type ParsedRecipeLine,
  type SkippedRecipeLine,
} from "@/lib/recipe"
import { formatWeight } from "@/lib/units"
import { cn } from "@/lib/utils"

type SortKey = "ingredient" | "amount" | "cost"

/** Sorts on the number the chef wrote, because that is the number on screen. */
function amountSortValue(line: ParsedRecipeLine): number {
  if (line.componentQuantity !== null) return line.componentQuantity.amount
  return line.enteredAmount
}

function displayUnit(line: ParsedRecipeLine): string {
  if (line.componentQuantity !== null) return "ea"
  if (line.enteredUnit) return line.enteredUnit
  if (line.normalizedUnit === "assumed-g") return "g"
  // No unit token and nothing matched: the line names an amount of something
  // whose measure is unknown, so it shows the amount alone.
  return line.normalizedUnit ?? ""
}

/** Kitchen fractions worth showing as written: "1/3 tbsp", not "0.333 tbsp". */
const KITCHEN_FRACTIONS: [number, string][] = [
  [1 / 8, "1/8"],
  [1 / 4, "1/4"],
  [1 / 3, "1/3"],
  [3 / 8, "3/8"],
  [1 / 2, "1/2"],
  [5 / 8, "5/8"],
  [2 / 3, "2/3"],
  [3 / 4, "3/4"],
  [7 / 8, "7/8"],
]

function formatAmount(amount: number): string {
  const whole = Math.floor(amount)
  const part = amount - whole
  if (part > 0.001 && part < 0.999) {
    for (const [value, label] of KITCHEN_FRACTIONS) {
      if (Math.abs(part - value) < 0.005) {
        return whole > 0 ? `${whole} ${label}` : label
      }
    }
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(
    amount
  )
}

/**
 * The costed ingredient lines, in the order they were written. No card of its
 * own: two rules close it top and bottom, the way every table in the handoff
 * is drawn, and the batch total sits inside them as the last row.
 */
export function RecipeLinesTable({
  lines,
  skipped,
  priced,
  priceList,
  resolvingLines,
  onAddLine,
  onDeleteLine,
  onEditLine,
  onSetWeight,
  onLinked,
  factor = 1,
  readOnly = false,
}: {
  lines: ParsedRecipeLine[]
  /** Lines in the recipe text that didn't read as ingredients. */
  skipped: SkippedRecipeLine[]
  priced: PricedLine[]
  priceList: PriceListEntry[]
  /** Lines still being matched after an import; they render as a spinner row. */
  resolvingLines?: Set<number>
  /** Appends a raw line ("650 g bread flour"); false means it was rejected. */
  onAddLine: (raw: string) => boolean
  /** Removes the numbered line from the recipe text. */
  onDeleteLine: (lineNumber: number) => void
  onEditLine: (line: ParsedRecipeLine, ingredientId: string | null) => void
  onSetWeight: (line: ParsedRecipeLine, ingredientId: string | null) => void
  /** A pantry pick from the alert's picker, which also renames the line. */
  onLinked: (match: PriceLineMatch) => void
  /** Batch multiplier applied to what is shown, never to what is stored. */
  factor?: number
  /** Rows are read-only: the recipe is locked, or the quantities on screen are
   * scaled and so are not the quantities an edit would write. */
  readOnly?: boolean
}) {
  const { currencyCode, measurementSystem } = useBusinessSettings()
  // Which row has the pantry picker open. The cost cell moved to Costing, so
  // the alert actions are what reach for it here.
  const [pickerLine, setPickerLine] = React.useState<number | null>(null)
  // The batch weight the cook reads off the bench; cost totals live on Costing.
  const totalGrams =
    lines.reduce((sum, line) => sum + (line.ingredient?.grams ?? 0), 0) * factor
  // Written order is the default: the table mirrors the text above it until
  // someone asks for another order.
  const [sort, setSort] = React.useState<{
    key: SortKey
    direction: "asc" | "desc"
  } | null>(null)
  // Held here, not in the dialog, so a row's alert can open its cost cell's picker.
  const [draftLine, setDraftLine] = React.useState("")
  const [draftRejected, setDraftRejected] = React.useState(false)
  const [highlighted, setHighlighted] = React.useState(-1)
  const draftInputRef = React.useRef<HTMLInputElement>(null)
  const unitPriceUnit = preferredWeightUnit(measurementSystem)

  // The name fragment being typed, whether the amount came first or not.
  const draftParsed = React.useMemo(
    () => parseRecipeText(draftLine.trim()).parsedLines[0] ?? null,
    [draftLine]
  )
  const draftName = draftParsed?.ingredientName ?? draftLine.trim()
  const suggestions = React.useMemo(() => {
    if (draftName.length < 2) return []
    // Ranked before the slice: the five rows shown are the five best matches,
    // not the first five in pantry order.
    return rankedIngredientMatches(priceList, draftName)
      .filter((entry) => entry.name.toLowerCase() !== draftName.toLowerCase())
      .slice(0, 5)
  }, [draftName, priceList])

  const completeSuggestion = (entry: PriceListEntry) => {
    const completed = draftParsed
      ? [
          String(draftParsed.enteredAmount),
          draftParsed.enteredUnit ??
            (draftParsed.normalizedUnit === "assumed-g"
              ? "g"
              : draftParsed.normalizedUnit),
          entry.name,
        ]
          .filter(Boolean)
          .join(" ")
      : entry.name
    // A complete line goes straight in; a bare name waits for its amount.
    if (draftParsed && onAddLine(completed)) {
      setDraftLine("")
    } else {
      setDraftLine(`${entry.name} `)
    }
    setHighlighted(-1)
    draftInputRef.current?.focus()
  }

  const rows = React.useMemo(() => {
    const paired = lines.map((line, index) => ({
      line,
      priced: priced[index] ?? null,
    }))
    if (!sort) return paired
    const factor = sort.direction === "asc" ? 1 : -1
    return [...paired].sort((left, right) => {
      if (sort.key === "ingredient") {
        return (
          factor *
          left.line.ingredientName.localeCompare(right.line.ingredientName)
        )
      }
      if (sort.key === "amount") {
        return (
          factor * (amountSortValue(left.line) - amountSortValue(right.line))
        )
      }
      // An unpriced line is not a cheap one: it sinks to the bottom either
      // way rather than sorting as zero.
      const leftCost = left.priced?.costCents ?? null
      const rightCost = right.priced?.costCents ?? null
      if (leftCost === null || rightCost === null) {
        if (leftCost === rightCost) return 0
        return leftCost === null ? 1 : -1
      }
      return factor * (leftCost - rightCost)
    })
  }, [lines, priced, sort])

  const toggle = (key: SortKey) =>
    setSort((current) =>
      current?.key !== key
        ? { key, direction: "asc" }
        : current.direction === "asc"
          ? { key, direction: "desc" }
          : null
    )

  const sortIcon = (key: SortKey) => {
    if (sort?.key !== key) {
      return (
        <ChevronsUpDown
          className="size-[11px] text-disabled-foreground"
          strokeWidth={2}
          aria-hidden="true"
        />
      )
    }
    return sort.direction === "asc" ? (
      <ChevronUp
        className="size-[11px] text-ink-soft"
        strokeWidth={2}
        aria-hidden="true"
      />
    ) : (
      <ChevronDown
        className="size-[11px] text-ink-soft"
        strokeWidth={2}
        aria-hidden="true"
      />
    )
  }

  const sortButton = (key: SortKey, label: string, alignEnd = false) => (
    <button
      type="button"
      onClick={() => toggle(key)}
      className={cn(
        "inline-flex items-center gap-[5px] rounded-md border border-transparent focus-visible:border-foreground focus-visible:outline-none",
        alignEnd && "justify-end"
      )}
    >
      {label}
      {sortIcon(key)}
    </button>
  )

  return (
    <TableFrame className="overflow-x-auto">
      <Table className="table-fixed">
        <TableHeader>
          {/* 44px here, a notch under the 48px of a screen-level table. */}
          <TableHeaderRow className="h-11">
            <TableHead className="w-[220px]">
              {sortButton("ingredient", "Ingredient")}
            </TableHead>
            {/* Takes the leftover width, so the name stays left and the
                alert/qty/unit cluster rides over to sit near Cost. */}
            <TableHead />
            {/* Reserved on every row so the columns never shift. */}
            <TableHead className="w-10" />
            <TableHead className="w-16 text-right">
              {sortButton("amount", "Qty", true)}
            </TableHead>
            <TableHead className="w-[124px]">Unit</TableHead>
            {/* Reserved for the hover-reveal row delete. */}
            <TableHead className="w-9" />
          </TableHeaderRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ line, priced: pricedLine }) => {
            if (resolvingLines?.has(line.lineNumber)) {
              return (
                <TableRow
                  key={`${line.lineNumber}-${line.rawLine}`}
                  className="h-11 hover:bg-transparent"
                >
                  <TableCell colSpan={5} className="text-base">
                    {line.rawLine}
                  </TableCell>
                  <TableCell colSpan={2}>
                    <Spinner
                      size="sm"
                      label="Matching ingredient"
                      className="ml-auto flex"
                    />
                  </TableCell>
                </TableRow>
              )
            }
            const entry = priceList.find(
              (candidate) => candidate.id === pricedLine?.ingredientId
            )
            // A component wins any name tie with a purchased ingredient, so a
            // merchant who both makes and buys the same item can otherwise not
            // see which source priced the line.
            const fromComponent = entry?.source === "component"
            const canOverrideMeasure =
              line.resolutionSource === "catalog-measure" ||
              line.resolutionSource === "density"
            const isCountedComponent = line.componentQuantity !== null
            const alert = recipeLineAlert(line, pricedLine)
            // A counted line against a weight-yield component can't convert:
            // say why, and point at both honest fixes.
            const pieceOnlyComponent =
              fromComponent &&
              entry.componentYieldUnit === "pcs" &&
              !entry.componentWeightKnown
            const alertLabel =
              alert === "no-conversion" && fromComponent
                ? `${entry.name} is measured by weight. Enter grams, or give the component a piece yield.`
                : alert === "no-conversion"
                  ? `${entry?.name ?? "This ingredient"} is not measured in ${line.enteredUnit ?? "that unit"}. Set a conversion on it, or add a preparation.`
                  : alert === "no-price" && pieceOnlyComponent
                    ? `${entry.name} is counted in pieces. Enter a count, or give it a weight yield so a weight can be costed.`
                    : alert
                      ? RECIPE_LINE_ALERT_LABELS[alert]
                      : ""
            const weight = line.ingredient ? (
              <>
                {canOverrideMeasure ? "~" : null}
                {formatWeight(
                  line.ingredient.grams * factor,
                  measurementSystem
                )}
                {line.measureRange?.requiresReview ? (
                  <span
                    className="ml-1.5 text-2xs text-warning-foreground"
                    title={`${formatWeight(line.measureRange.lowGrams, measurementSystem)}–${formatWeight(line.measureRange.highGrams, measurementSystem)} possible range`}
                  >
                    review
                  </span>
                ) : null}
              </>
            ) : null
            // A mass unit is already the weight; no note needed.
            const showWeightNote =
              line.ingredient !== null &&
              line.resolutionSource !== "entered-weight" &&
              line.resolutionSource !== "converted-weight"
            return (
              <TableRow
                key={`${line.lineNumber}-${line.rawLine}`}
                className={cn(
                  "group/row h-11",
                  !isCountedComponent && !readOnly && "cursor-pointer"
                )}
                onClick={(event) => {
                  // Controls in this row own their own click; their dialogs
                  // portal out but still bubble through the React tree.
                  if (!event.currentTarget.contains(event.target as Node))
                    return
                  if ((event.target as HTMLElement).closest("a,button")) return
                  if (isCountedComponent || readOnly) return
                  onEditLine(line, pricedLine?.ingredientId ?? null)
                }}
              >
                <TableCell>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-md">
                      {line.ingredientName}
                    </span>
                    {fromComponent ? (
                      <Badge
                        className="shrink-0 rounded-sm px-[7px] py-0.5 text-2xs"
                        title="Priced from a component recipe, not a purchased ingredient"
                      >
                        Component
                      </Badge>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell />
                <TableCell className="pr-0">
                  {alert ? (
                    <AlertFlag
                      label={alertLabel}
                      width={
                        (alert === "no-conversion" && fromComponent) ||
                        (alert === "no-price" && pieceOnlyComponent)
                          ? 260
                          : alert === "no-price"
                            ? 190
                            : 210
                      }
                      actions={
                        alert === "no-price" && pieceOnlyComponent
                          ? undefined
                          : alert === "not-recognized"
                            ? [
                                {
                                  label: "Find it in the pantry",
                                  onClick: () => setPickerLine(line.lineNumber),
                                },
                              ]
                            : alert === "no-conversion"
                              ? [
                                  {
                                    label: "Set weight",
                                    onClick: () =>
                                      onSetWeight(
                                        line,
                                        pricedLine?.ingredientId ?? null
                                      ),
                                  },
                                ]
                              : [
                                  {
                                    label: "Add a price",
                                    onClick: () =>
                                      setPickerLine(line.lineNumber),
                                  },
                                ]
                      }
                    />
                  ) : null}
                  <PriceLineDialog
                    lineName={line.ingredientName}
                    priceList={priceList}
                    onLinked={onLinked}
                    trigger={null}
                    open={pickerLine === line.lineNumber}
                    onOpenChange={(next) =>
                      setPickerLine(next ? line.lineNumber : null)
                    }
                  />
                </TableCell>
                <TableCell className="text-right text-base text-muted-foreground tabular-nums">
                  {formatAmount(
                    (line.componentQuantity?.amount ?? line.enteredAmount) *
                      factor
                  )}
                </TableCell>
                <TableCell className="text-base whitespace-nowrap text-muted-foreground">
                  {/* A fixed slot, so every row's weight note starts at the
                      same x whether the unit reads "g" or "tbsp". */}
                  <span className="inline-block w-9">{displayUnit(line)}</span>
                  {showWeightNote ? (
                    <span className="text-2xs text-faint">
                      {canOverrideMeasure ? (
                        <button
                          type="button"
                          className="underline-offset-4 hover:underline"
                          title="Replace this catalog estimate and optionally remember it"
                          onClick={() =>
                            onSetWeight(line, pricedLine?.ingredientId ?? null)
                          }
                        >
                          {weight}
                        </button>
                      ) : (
                        weight
                      )}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="pr-2 text-right">
                  {readOnly ? null : (
                    <button
                      type="button"
                      aria-label={`Remove ${line.ingredientName}`}
                      title="Remove ingredient"
                      onClick={() => onDeleteLine(line.lineNumber)}
                      className="rounded-md p-1 align-middle text-faint opacity-0 group-hover/row:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none"
                    >
                      <X
                        aria-hidden="true"
                        strokeWidth={1.8}
                        className="size-[15px]"
                      />
                    </button>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
          {/* A line the parser couldn't read stays visible instead of
              silently living on in the recipe text. */}
          {skipped.map((line) =>
            resolvingLines?.has(line.lineNumber) ? (
              <TableRow
                key={`skipped-${line.lineNumber}-${line.rawLine}`}
                className="h-11 hover:bg-transparent"
              >
                <TableCell colSpan={5} className="text-base">
                  {line.rawLine}
                </TableCell>
                <TableCell colSpan={2}>
                  <Spinner
                    size="sm"
                    label="Matching ingredient"
                    className="ml-auto flex"
                  />
                </TableCell>
              </TableRow>
            ) : (
              <TableRow
                key={`skipped-${line.lineNumber}-${line.rawLine}`}
                className="group/row h-11"
              >
                <TableCell colSpan={2} className="text-md">
                  {line.rawLine}
                </TableCell>
                <TableCell className="pr-0">
                  <AlertFlag label={line.reason} width={230} />
                </TableCell>
                <TableCell colSpan={3} />
                <TableCell className="pr-2 text-right">
                  {readOnly ? null : (
                    <button
                      type="button"
                      aria-label={`Remove ${line.rawLine}`}
                      title="Remove line"
                      onClick={() => onDeleteLine(line.lineNumber)}
                      className="rounded-md p-1 align-middle text-faint opacity-0 group-hover/row:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none"
                    >
                      <X
                        aria-hidden="true"
                        strokeWidth={1.8}
                        className="size-[15px]"
                      />
                    </button>
                  )}
                </TableCell>
              </TableRow>
            )
          )}
          {/* Written like any other row: type a line, Enter adds it and keeps
              the caret here for the next one. */}
          {readOnly ? null : (
            <TableRow className="h-11 hover:bg-transparent">
              <TableCell colSpan={6}>
                <div className="flex items-center gap-2">
                  <Plus
                    aria-hidden="true"
                    strokeWidth={1.8}
                    className="size-[15px] shrink-0 text-muted-foreground"
                  />
                  <input
                    ref={draftInputRef}
                    type="text"
                    value={draftLine}
                    onChange={(event) => {
                      setDraftLine(event.target.value)
                      setDraftRejected(false)
                      setHighlighted(-1)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" && suggestions.length > 0) {
                        event.preventDefault()
                        setHighlighted((i) =>
                          i >= suggestions.length - 1 ? 0 : i + 1
                        )
                        return
                      }
                      if (event.key === "ArrowUp" && suggestions.length > 0) {
                        event.preventDefault()
                        setHighlighted((i) =>
                          i <= 0 ? suggestions.length - 1 : i - 1
                        )
                        return
                      }
                      if (event.key === "Escape") {
                        setHighlighted(-1)
                        return
                      }
                      if (event.key !== "Enter") return
                      event.preventDefault()
                      if (highlighted >= 0 && suggestions[highlighted]) {
                        completeSuggestion(suggestions[highlighted])
                        return
                      }
                      const raw = draftLine.trim()
                      if (!raw) return
                      if (onAddLine(raw)) {
                        setDraftLine("")
                      } else {
                        setDraftRejected(true)
                      }
                    }}
                    placeholder="Add ingredient"
                    spellCheck={false}
                    aria-label="Add ingredient line"
                    aria-invalid={draftRejected || undefined}
                    className="w-full bg-transparent text-md outline-none placeholder:text-faint"
                  />
                </div>
              </TableCell>
            </TableRow>
          )}
          {/* Matches from the pantry, as rows under the caret: click or
              arrow-and-Enter completes the typed name. */}
          {suggestions.map((entry, index) => (
            <TableRow
              key={`suggestion-${entry.id}`}
              className={cn(
                "h-9 border-b-0 hover:bg-transparent",
                index === highlighted && "bg-fill-soft"
              )}
            >
              <TableCell colSpan={6} className="py-0">
                <button
                  type="button"
                  onClick={() => completeSuggestion(entry)}
                  className="flex h-9 w-full items-center justify-between gap-3 pl-[23px] text-left hover:bg-fill-soft focus-visible:bg-fill-soft focus-visible:outline-none"
                >
                  <span className="min-w-0 truncate text-base">
                    {entry.name}
                  </span>
                  <span className="shrink-0 pr-2 text-xs text-muted-foreground tabular-nums">
                    {formatUnitPrice(
                      entry.purchaseCostCents,
                      entry.purchaseSize,
                      entry.purchaseUnit,
                      unitPriceUnit,
                      currencyCode
                    )}
                    /{unitPriceUnit}
                  </span>
                </button>
              </TableCell>
            </TableRow>
          ))}
          {draftRejected ? (
            <TableRow className="h-9 border-b-0 hover:bg-transparent">
              <TableCell colSpan={6}>
                <p role="alert" className="text-xs text-destructive">
                  Add an amount, e.g. 20 g bread flour
                </p>
              </TableCell>
            </TableRow>
          ) : null}
          {/* The batch total lives inside the frame, on no rule of its own. */}
          <TableRow className="h-12 border-b-0 hover:bg-transparent">
            <TableCell colSpan={4} className="text-base font-medium">
              Total weight
            </TableCell>
            <TableCell
              colSpan={2}
              className="text-right text-base font-medium tabular-nums"
            >
              {formatWeight(totalGrams, measurementSystem)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </TableFrame>
  )
}
