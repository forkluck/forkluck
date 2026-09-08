"use client"

import * as React from "react"
import { Download, TriangleAlert, Upload } from "lucide-react"

import {
  importIngredients,
  parsePurchaseFile,
  type ImportReceipt,
} from "@/app/(app)/ingredients/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  LabeledInput,
  LabeledShell,
  labeledControlClassName,
} from "@/components/ui/labeled-field"
import { Stat } from "@/components/ui/metric-card"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { centsToDollarInput, dollarsToCents, formatCents } from "@/lib/money"
import type { IngredientOption } from "@/components/ingredients/types"
import { preferredWeightUnit } from "@/lib/business-settings"
import { readAsBase64 } from "@/lib/client-file"
import { formatUnitPrice } from "@/lib/pricing"
import {
  packGramsFor,
  type PurchaseEntry,
  type PurchaseImport,
  type SkippedPurchaseRow,
} from "@/lib/purchase-import"
import {
  isPackUnit,
  packUnitGroups,
  type PackUnitSlug,
} from "@/lib/unit-registry"
import { cn } from "@/lib/utils"
import { formatCalendarDate } from "@/lib/datetime"

const PACK_UNIT_GROUPS = packUnitGroups()

/** A "create a new ingredient" choice needs a value the picker can carry. */
const CREATE_NEW = "new"

function periodLabel(preview: PurchaseImport) {
  const { source } = preview
  if (!source?.periodStart || !source.periodEnd) return "Purchase report"
  return `${formatCalendarDate(source.periodStart)} – ${formatCalendarDate(source.periodEnd)}`
}

/** The row state machine the recipe paste preview drives too. */
export type ReviewMode = "review" | "resolving" | "resolved" | "ignored"

type ReviewItem = SkippedPurchaseRow & {
  key: string
  mode: ReviewMode
  amount: string
  /** A slug from the purchase vocabulary — a weight, a volume or a count. */
  unit: PackUnitSlug
  price: string
  ingredientId: string
}

function reviewItems(
  rows: SkippedPurchaseRow[],
  defaultUnit: PackUnitSlug
): ReviewItem[] {
  return rows.map((row, index) => ({
    ...row,
    key: `${row.externalId ?? row.name}-${index}`,
    mode: row.status === "ignored" ? "ignored" : "review",
    amount:
      row.suggestedPackAmount === null ? "" : String(row.suggestedPackAmount),
    unit: isPackUnit(row.suggestedPackUnit)
      ? row.suggestedPackUnit
      : defaultUnit,
    price:
      row.packPriceCents === null ? "" : centsToDollarInput(row.packPriceCents),
    ingredientId: "",
  }))
}

function resolvedEntry(
  item: ReviewItem,
  ingredients: IngredientOption[]
): PurchaseEntry | null {
  if (item.mode !== "resolved") return null
  const amount = Number(item.amount)
  const packPriceCents = dollarsToCents(item.price)
  if (!Number.isFinite(amount) || amount <= 0 || !packPriceCents) return null
  const matched = ingredients.find(
    (ingredient) => ingredient.id === item.ingredientId
  )
  return {
    supplier: item.supplier,
    externalId: item.externalId,
    name: matched?.name ?? item.name,
    rawSize: item.rawSize,
    quantity: item.quantity,
    packAmount: amount,
    packUnit: item.unit,
    packGrams: packGramsFor(amount, item.unit),
    packPriceCents,
    preferred: false,
    status: "new",
    ingredientId: matched?.id ?? null,
  }
}

function ImportSummary({
  preview,
  ready,
  reviews,
}: {
  preview: PurchaseImport
  ready: PurchaseEntry[]
  reviews: ReviewItem[]
}) {
  const newCount = ready.filter((entry) => entry.status === "new").length
  const updateCount = ready.length - newCount
  const unresolved = reviews.filter(
    (row) => row.mode === "review" || row.mode === "resolving"
  ).length

  return (
    <div className="rounded-xl border border-border bg-fill-soft p-3.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-md">
          {preview.source?.label ?? "Purchase report"}
        </span>
        {preview.source ? (
          <Badge className="rounded-sm px-[7px] py-0.5 text-2xs">
            Detected
          </Badge>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-faint">{periodLabel(preview)}</p>
      <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-muted pt-3 sm:grid-cols-4">
        <Stat label="Ready" value={ready.length} />
        <Stat label="New / update" value={`${newCount} / ${updateCount}`} />
        <Stat label="Review" value={unresolved} />
        <Stat
          label="Ignored"
          value={reviews.filter((row) => row.mode === "ignored").length}
        />
      </dl>
    </div>
  )
}

function ReadyTable({
  preview,
  entries,
}: {
  preview: PurchaseImport
  entries: PurchaseEntry[]
}) {
  const { currencyCode, measurementSystem } = useBusinessSettings()
  const unitPriceUnit = preferredWeightUnit(measurementSystem)
  if (entries.length === 0) return null
  const headClass =
    "py-0 pr-3 pl-0 text-2xs leading-none font-medium whitespace-nowrap text-ink-soft last:pr-0"
  const cellClass = "py-0 pr-3 pl-0 last:pr-0"
  return (
    <div className="max-h-64 overflow-auto border-t border-b border-t-muted border-b-border px-0.5">
      <table className="w-full border-collapse text-md">
        <thead>
          <tr className="h-12 border-b border-border text-left">
            {preview.source ? (
              <th className={headClass}>{preview.source.label} ID</th>
            ) : null}
            <th className={headClass}>Ingredient</th>
            <th className={cn(headClass, "text-right")}>Pack</th>
            <th className={cn(headClass, "text-right")}>Quantity</th>
            <th className={cn(headClass, "text-right")}>Price</th>
            <th className={cn(headClass, "text-right")}>
              {currencyCode} / {unitPriceUnit}
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr
              key={`${entry.supplier ?? "file"}-${entry.externalId ?? entry.name}-${index}`}
              className="h-12 border-b border-muted last:border-b-0"
            >
              {preview.source ? (
                <td className={cn(cellClass, "whitespace-nowrap")}>
                  <span className="text-base text-muted-foreground">
                    {entry.externalId}
                  </span>
                  <Badge className="ml-2 rounded-sm px-[7px] py-0.5 text-2xs">
                    {entry.status === "new" ? "New" : "Update"}
                  </Badge>
                </td>
              ) : null}
              <td className={cn(cellClass, "w-full max-w-0")}>
                <span className="block truncate">{entry.name}</span>
              </td>
              <td
                className={cn(
                  cellClass,
                  "text-right text-base whitespace-nowrap text-muted-foreground tabular-nums"
                )}
              >
                {entry.rawSize || `${entry.packAmount} ${entry.packUnit}`}
              </td>
              <td
                className={cn(
                  cellClass,
                  "text-right text-base whitespace-nowrap text-muted-foreground tabular-nums"
                )}
              >
                {entry.quantity ?? "—"}
              </td>
              <td
                className={cn(
                  cellClass,
                  "text-right text-base whitespace-nowrap text-muted-foreground tabular-nums"
                )}
              >
                {formatCents(entry.packPriceCents, currencyCode)}
              </td>
              <td
                className={cn(
                  cellClass,
                  "text-right text-base whitespace-nowrap text-muted-foreground tabular-nums"
                )}
              >
                {formatUnitPrice(
                  entry.packPriceCents,
                  entry.packAmount,
                  entry.packUnit,
                  unitPriceUnit,
                  currencyCode
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReviewQueue({
  reviews,
  ingredients,
  onChange,
}: {
  reviews: ReviewItem[]
  ingredients: IngredientOption[]
  onChange: (key: string, patch: Partial<ReviewItem>) => void
}) {
  const { currencyCode } = useBusinessSettings()
  if (reviews.length === 0) return null
  const unresolved = reviews.filter(
    (row) => row.mode === "review" || row.mode === "resolving"
  )
  return (
    <details className="group rounded-xl border border-border">
      <summary className="flex h-12 cursor-pointer list-none items-center gap-2.5 px-3.5 text-base [&::-webkit-details-marker]:hidden">
        <TriangleAlert
          className="size-4 shrink-0 text-warning"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        Supplier rows that need review
        <Badge className="rounded-sm px-[7px] py-0.5 text-2xs">
          {unresolved.length}
        </Badge>
        <span className="ml-auto text-xs text-faint group-open:hidden">
          Show
        </span>
      </summary>
      <div className="border-t border-muted">
        {unresolved.length > 0 ? (
          <div className="flex flex-col items-start gap-2 border-b border-muted px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <p className="text-xs leading-[1.55] text-muted-foreground">
              Resolve the products you care about, or ignore rows you never want
              to see again.
            </p>
            <Button
              variant="ghost"
              className="shrink-0 text-foreground"
              onClick={() => {
                for (const row of unresolved) {
                  onChange(row.key, { mode: "ignored" })
                }
              }}
            >
              Ignore unresolved
            </Button>
          </div>
        ) : null}
        <div className="max-h-72 divide-y divide-muted overflow-auto">
          {reviews.map((row) => {
            const amount = Number(row.amount)
            const price = dollarsToCents(row.price)
            const validResolution =
              row.externalId !== null &&
              Number.isFinite(amount) &&
              amount > 0 &&
              price !== null &&
              price > 0
            return (
              <div key={row.key} className="px-3.5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-md">
                      {row.externalId ? `${row.externalId} · ` : ""}
                      {row.name}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-faint">
                      {row.rawSize ? `${row.rawSize} · ` : ""}
                      {row.reason}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {row.mode === "ignored" ? (
                      <>
                        <Badge className="rounded-sm px-[7px] py-0.5 text-2xs">
                          Ignored
                        </Badge>
                        <Button
                          variant="ghost"
                          className="text-foreground"
                          onClick={() =>
                            onChange(row.key, { mode: "resolving" })
                          }
                        >
                          Review again
                        </Button>
                      </>
                    ) : row.mode === "resolved" ? (
                      <>
                        <Badge className="rounded-sm px-[7px] py-0.5 text-2xs">
                          Resolved
                        </Badge>
                        <Button
                          variant="ghost"
                          className="text-foreground"
                          onClick={() =>
                            onChange(row.key, { mode: "resolving" })
                          }
                        >
                          Edit
                        </Button>
                      </>
                    ) : row.mode === "review" ? (
                      <>
                        <Button
                          variant="outline"
                          disabled={!row.externalId}
                          onClick={() =>
                            onChange(row.key, { mode: "resolving" })
                          }
                        >
                          Resolve
                        </Button>
                        {row.supplier && row.externalId ? (
                          <Button
                            variant="ghost"
                            className="text-foreground"
                            onClick={() =>
                              onChange(row.key, { mode: "ignored" })
                            }
                          >
                            Ignore
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>

                {row.mode === "resolving" ? (
                  <div className="mt-3 rounded-xl border border-border bg-fill-soft p-3.5">
                    <LabeledShell label="Match ingredient">
                      <Select
                        value={row.ingredientId || CREATE_NEW}
                        onValueChange={(value) =>
                          onChange(row.key, {
                            ingredientId:
                              typeof value === "string" && value !== CREATE_NEW
                                ? value
                                : "",
                          })
                        }
                      >
                        <SelectTrigger
                          id={`match-${row.key}`}
                          aria-label="Match ingredient"
                          className={cn(
                            labeledControlClassName,
                            "justify-between"
                          )}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-64">
                          <SelectItem value={CREATE_NEW}>
                            Create “{row.name}”
                          </SelectItem>
                          {ingredients.map((ingredient) => (
                            <SelectItem
                              key={ingredient.id}
                              value={ingredient.id}
                            >
                              {ingredient.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </LabeledShell>

                    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_96px]">
                      <LabeledInput
                        label={`Pack price (${currencyCode})`}
                        id={`price-${row.key}`}
                        inputMode="decimal"
                        value={row.price}
                        onChange={(event) =>
                          onChange(row.key, { price: event.target.value })
                        }
                        className="tabular-nums"
                      />
                      <LabeledInput
                        label="Pack size"
                        id={`weight-${row.key}`}
                        type="number"
                        min="0"
                        step="any"
                        value={row.amount}
                        onChange={(event) =>
                          onChange(row.key, { amount: event.target.value })
                        }
                        className="tabular-nums"
                      />
                      <LabeledShell label="Unit">
                        <Select
                          value={row.unit}
                          onValueChange={(value) => {
                            if (isPackUnit(value)) {
                              onChange(row.key, { unit: value })
                            }
                          }}
                        >
                          <SelectTrigger
                            aria-label="Pack size unit"
                            className={cn(
                              labeledControlClassName,
                              "justify-between"
                            )}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent align="end" className="w-33">
                            {PACK_UNIT_GROUPS.map((group) => (
                              <SelectGroup key={group.heading}>
                                <SelectLabel>{group.heading}</SelectLabel>
                                {group.units.map((unit) => (
                                  <SelectItem key={unit.slug} value={unit.slug}>
                                    {unit.slug}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ))}
                          </SelectContent>
                        </Select>
                      </LabeledShell>
                    </div>

                    <p className="mt-3 text-xs leading-[1.55] text-muted-foreground">
                      Enter the pack in the unit it was bought by. A pack
                      counted in pieces needs the weight of one before recipes
                      that weigh it can cost; set that on the ingredient’s
                      Conversions.
                    </p>
                    <div className="mt-4 flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => onChange(row.key, { mode: "review" })}
                      >
                        Cancel
                      </Button>
                      <Button
                        disabled={!validResolution}
                        onClick={() => onChange(row.key, { mode: "resolved" })}
                      >
                        Add to import
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </details>
  )
}

function ImportReceiptView({
  receipt,
  onDone,
}: {
  receipt: ImportReceipt
  onDone: () => void
}) {
  return (
    <div>
      <div className="rounded-xl border border-border bg-fill-soft p-3.5">
        <p className="text-md">
          {receipt.imported} supplier product
          {receipt.imported === 1 ? "" : "s"} saved
        </p>
        <p className="mt-0.5 text-xs text-faint">
          The receipt is in Import history and can be undone while it is the
          latest active import.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-muted pt-3 sm:grid-cols-4">
          <Stat label="New" value={receipt.created} />
          <Stat label="Updated" value={receipt.updated} />
          <Stat label="Ignored" value={receipt.ignored} />
          <Stat label="Review later" value={receipt.review} />
        </dl>
      </div>
      <div className="mt-5 flex justify-end">
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  )
}

function ImportBody({
  ingredients,
  onDone,
}: {
  ingredients: IngredientOption[]
  onDone: () => void
}) {
  const { measurementSystem } = useBusinessSettings()
  const defaultUnit = preferredWeightUnit(measurementSystem)
  const [busy, setBusy] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<PurchaseImport | null>(null)
  const [fileName, setFileName] = React.useState("")
  const [reviews, setReviews] = React.useState<ReviewItem[]>([])
  const [receipt, setReceipt] = React.useState<ImportReceipt | null>(null)

  const readyEntries = React.useMemo(
    () => [
      ...(preview?.entries ?? []),
      ...reviews
        .map((row) => resolvedEntry(row, ingredients))
        .filter((row): row is PurchaseEntry => row !== null),
    ],
    [ingredients, preview, reviews]
  )
  const ignoredRows = reviews.filter(
    (row) => row.mode === "ignored" && row.supplier && row.externalId
  )
  const unresolvedCount = reviews.filter(
    (row) => row.mode === "review" || row.mode === "resolving"
  ).length

  const changeReview = (key: string, patch: Partial<ReviewItem>) => {
    setReviews((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row))
    )
  }

  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    setPreview(null)
    setReceipt(null)
    setFileName(file.name)
    try {
      const result = await parsePurchaseFile(
        await readAsBase64(file),
        file.name
      )
      if ("error" in result) {
        setError(result.error)
      } else {
        setPreview(result)
        setReviews(reviewItems(result.skipped, defaultUnit))
        if (result.entries.length === 0 && result.skipped.length === 0) {
          setError("No usable rows found in that file.")
        }
      }
    } catch {
      setError("Couldn't read that file — try again.")
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!preview || readyEntries.length + ignoredRows.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await importIngredients({
        entries: readyEntries.map((entry) => ({
          supplier: entry.supplier,
          externalId: entry.externalId,
          name: entry.name,
          rawSize: entry.rawSize,
          quantity: entry.quantity,
          packAmount: entry.packAmount,
          packUnit: entry.packUnit,
          packPriceCents: entry.packPriceCents,
          periodStart: preview.source?.periodStart ?? null,
          periodEnd: preview.source?.periodEnd ?? null,
          preferred: entry.preferred,
          ingredientId: entry.ingredientId,
        })),
        ignored: ignoredRows.map((row) => ({
          supplier: row.supplier!,
          externalId: row.externalId!,
          name: row.name,
          rawSize: row.rawSize,
        })),
        fileName,
        source: preview.source
          ? {
              supplier: preview.source.supplier,
              periodStart: preview.source.periodStart,
              periodEnd: preview.source.periodEnd,
            }
          : null,
        totalRows: preview.totalRows,
        reviewCount: unresolvedCount,
      })
      if ("error" in result) {
        setError(result.error)
        return
      }
      setReceipt(result)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Import failed — check your connection and try again."
      )
    } finally {
      setBusy(false)
    }
  }

  if (receipt) return <ImportReceiptView receipt={receipt} onDone={onDone} />

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* The drop zone: 1.5px dashed line, no fill until a file is over it. */}
      <label
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void pick(event.dataTransfer.files?.[0])
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-xl border-[1.5px] border-dashed border-line-strong px-6 py-8 text-center",
          dragging && "bg-fill-soft"
        )}
      >
        <Upload
          className="size-5 text-muted-foreground"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="mt-2 text-md font-medium">
          {busy
            ? "Reading the file…"
            : fileName || "Drop a purchase report to upload"}
        </span>
        <span className="mt-1 text-sm text-muted-foreground">
          Supplier exports and other .xlsx or .csv reports
        </span>
        <input
          type="file"
          className="sr-only"
          accept=".xlsx,.xls,.csv,.tsv,.txt"
          disabled={busy}
          onChange={(event) => void pick(event.target.files?.[0])}
        />
      </label>

      {preview ? (
        <ImportSummary
          preview={preview}
          ready={readyEntries}
          reviews={reviews}
        />
      ) : null}

      {preview ? <ReadyTable preview={preview} entries={readyEntries} /> : null}

      <ReviewQueue
        reviews={reviews}
        ingredients={ingredients}
        onChange={changeReview}
      />

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-2 flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={
            busy || !preview || readyEntries.length + ignoredRows.length === 0
          }
          onClick={() => void confirm()}
        >
          {busy
            ? "Working…"
            : readyEntries.length > 0
              ? `Import ${readyEntries.length} product${readyEntries.length === 1 ? "" : "s"}`
              : ignoredRows.length > 0
                ? "Save ignored items"
                : "Import"}
        </Button>
      </div>
    </div>
  )
}

export function ImportIngredientsDialog({
  ingredients,
  open: controlledOpen,
  onOpenChange,
}: {
  ingredients: IngredientOption[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : uncontrolledOpen
  const setOpen = isControlled
    ? (onOpenChange ?? (() => {}))
    : setUncontrolledOpen

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {isControlled ? null : (
        <DialogTrigger render={<Button variant="outline" />}>
          <Download strokeWidth={1.8} aria-hidden="true" />
          Import ingredients
        </DialogTrigger>
      )}
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Import supplier products</DialogTitle>
          <DialogDescription>
            Supplier IDs are kept, known products are updated, and rows that
            cannot be read land in a review queue instead of being guessed at.
          </DialogDescription>
        </DialogHeader>
        <ImportBody ingredients={ingredients} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}
