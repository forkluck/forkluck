"use client"

import * as React from "react"

import { Popover } from "@base-ui/react/popover"
import { Info, Link2, Search } from "lucide-react"

import { searchInvoiceItems } from "@/app/(app)/ingredients/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { LabeledInput } from "@/components/ui/labeled-field"
import { UnitCombobox } from "@/components/ingredients/unit-combobox"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  purchaseUnitOptions,
  unitDefinition,
  unitShort,
} from "@/lib/unit-registry"
import { centsToDollarInput, formatCents } from "@/lib/money"
import { cn } from "@/lib/utils"
import type { IngredientRow, InvoiceLineOption } from "@/lib/backend/types"

const PURCHASE_UNITS = purchaseUnitOptions()

/** A picked line's plain invoice date, which carries no time and so is read
 *  as UTC rather than sliding a day back west of it. */
const invoiceDateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})

export type PurchaseUnit = {
  cost: string
  size: string
  unit: string | null
  /** The usable share after trim, as a percent. Blank reads as a full 100. */
  yieldPercent: string
  /** The invoice line this pack was read off, linked when the form saves. */
  invoiceLineId?: string | null
  invoicePurchaseSize?: string
  invoicePurchaseUnit?: string
  /** Drop exactly one price reference when the form saves. */
  disconnectInvoicePriceId?: string | null
  /** Explicitly copy one invoice price into the active ingredient cost. */
  useInvoicePriceId?: string | null
}

/** What a screen starts from when nothing has been bought yet. */
export const EMPTY_PURCHASE_UNIT: PurchaseUnit = {
  cost: "",
  size: "",
  unit: null,
  yieldPercent: "100",
}

/** The pack as the one free-text field shows it: "25 lb". */
export function purchaseSizeLabel(size: string, unit: string | null) {
  if (!size) return ""
  if (!unit) return size
  const label = unit === "cup" ? "cup" : unitShort(unit)
  if (!label) return size
  // One of a per-piece item is written the way it is bought: "ea", not "1 ea".
  // A weight or volume always keeps its number, so "1 lb" stays "1 lb".
  if (size === "1" && unitDefinition(unit)?.family === "count") return label
  return `${size} ${label}`
}

/** The purchase unit a bare word names, "lb" or "each", or null. */
function matchPurchaseUnit(word: string) {
  const typed = word
    .trim()
    .replace(/\s+case$/i, "")
    .toLocaleLowerCase()
  if (!typed) return null
  if (/^(?:ct|count)$/.test(typed)) return "each"
  const option = PURCHASE_UNITS.find(({ slug }) => {
    const unit = unitDefinition(slug)
    if (!unit) return false
    if (
      [unit.slug, unit.short, unit.label].some(
        (candidate) => candidate.toLocaleLowerCase() === typed
      )
    )
      return true
    return unit.pattern
      ? new RegExp(`^(?:${unit.pattern})$`, "i").test(typed)
      : false
  })
  return option?.slug ?? null
}

const roundPack = (amount: number) => String(Number(amount.toFixed(6)))

/**
 * What a typed or invoiced size means, as a stored `{ size, unit }`:
 * "200 lb" and "946ml" carry their unit into the dropdown, "36X1 LB" and
 * "9X3 LB" multiply out to one weight, "12 ct" is 12 each, a bare "200" keeps
 * the unit already chosen, and a lone per-piece word ("ea") is one of it.
 * Null when the text names no unit the field could save.
 */
export function parseTypedSize(
  text: string,
  currentUnit: string | null = null
) {
  const trimmed = text.trim()
  if (trimmed === "") return null
  const multi = trimmed.match(/^([\d.]+)\s*[x\u00d7]\s*([\d.]+)\s*(.+)$/i)
  if (multi) {
    const unit = matchPurchaseUnit(multi[3])
    const count = Number(multi[1])
    const each = Number(multi[2])
    if (unit && count > 0 && each > 0) {
      return { size: roundPack(count * each), unit }
    }
    return null
  }
  // The unit begins where the digits end, so a bare "200" falls through to the
  // number case below rather than reading its last digit as a unit.
  const numberUnit = trimmed.match(/^([\d.]+)\s*([A-Za-z].*)$/)
  if (numberUnit) {
    const unit = matchPurchaseUnit(numberUnit[2])
    return unit ? { size: numberUnit[1], unit } : null
  }
  // A bare number keeps whatever unit the dropdown already holds.
  if (/^[\d.]+$/.test(trimmed))
    return { size: trimmed, unit: currentUnit ?? "" }
  // A per-piece unit typed on its own is one of it: "ea" means "1 ea". Weight
  // and volume need a number, so a bare "lb" is still nothing to save.
  const bare = matchPurchaseUnit(trimmed)
  if (bare && unitDefinition(bare)?.family === "count") {
    return { size: "1", unit: bare }
  }
  return null
}

/** Only the pack decides whether the size text needs writing back. */
const packKey = (unit: PurchaseUnit) => `${unit.size}|${unit.unit ?? ""}`

/** What one pack on an invoice line cost: the unit price when the invoice
 *  states one, else the line amount over its quantity. */
export function optionPackPriceCents(item: InvoiceLineOption) {
  if (item.unitPriceCents !== null) return item.unitPriceCents
  if (item.quantity !== null && item.quantity > 0) {
    return Math.round(item.lineAmountCents / item.quantity)
  }
  return item.lineAmountCents
}

/** How few characters are worth a search: one letter matches the invoices. */
const MIN_QUERY = 2

/**
 * The invoice line this pack is bought as, searched from the form itself.
 * The matches drop under the field rather than through a second modal.
 */
function InvoiceItemSearch({
  onPick,
}: {
  onPick: (item: InvoiceLineOption) => void
}) {
  // The results are portalled out of the dialog, so they anchor to this box
  // rather than being clipped by the dialog's own scrolling.
  const fieldRef = React.useRef<HTMLDivElement>(null)
  const [query, setQuery] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const [highlighted, setHighlighted] = React.useState(-1)
  // Results carry the word that fetched them, so a slow answer can never land
  // under a query the cook has already typed past.
  const [answer, setAnswer] = React.useState<{
    needle: string
    items: InvoiceLineOption[]
    error: string | null
  }>({ needle: "", items: [], error: null })

  const needle = query.trim()
  const wanted = needle.length >= MIN_QUERY

  React.useEffect(() => {
    if (!wanted) return
    let live = true
    void searchInvoiceItems(needle).then((result) => {
      if (!live) return
      setAnswer({
        needle,
        items: "error" in result ? [] : result.items,
        error: "error" in result ? result.error : null,
      })
    })
    return () => {
      live = false
    }
  }, [needle, wanted])

  const answered = answer.needle === needle
  const items = wanted && answered ? answer.items : []
  const listed = open && wanted

  const pick = (item: InvoiceLineOption) => {
    setOpen(false)
    setHighlighted(-1)
    setQuery("")
    onPick(item)
  }

  const messageClassName =
    "flex h-9 items-center px-2.5 text-xs text-muted-foreground"

  return (
    <div className="relative" ref={fieldRef}>
      <LabeledInput
        label="Invoice item"
        value={query}
        placeholder="Search invoice items by name or code"
        // The magnifier sits at the trailing edge; `pr-9` is the room one icon
        // needs, not `trailing`'s.
        className="pr-9"
        trailing={
          <Search
            className="pointer-events-none size-[15px] text-faint"
            strokeWidth={2}
            aria-hidden="true"
          />
        }
        role="combobox"
        aria-expanded={listed}
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value)
          setHighlighted(-1)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false)
          setHighlighted(-1)
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && items.length > 0) {
            event.preventDefault()
            setOpen(true)
            setHighlighted((index) =>
              index >= items.length - 1 ? 0 : index + 1
            )
            return
          }
          if (event.key === "ArrowUp" && items.length > 0) {
            event.preventDefault()
            setOpen(true)
            setHighlighted((index) =>
              index <= 0 ? items.length - 1 : index - 1
            )
            return
          }
          if (event.key === "Escape") {
            // With no list left to close, Escape belongs to whatever these
            // fields sit in.
            if (!listed) return
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            setHighlighted(-1)
            return
          }
          if (event.key !== "Enter") return
          const item = highlighted >= 0 ? items[highlighted] : null
          if (!item) return
          event.preventDefault()
          pick(item)
        }}
      />
      <Popover.Root open={listed} onOpenChange={setOpen}>
        <Popover.Portal>
          <Popover.Positioner
            anchor={fieldRef}
            align="start"
            sideOffset={4}
            className="z-50"
          >
            <Popover.Popup
              // The cook keeps typing while the list is up, so the popup never
              // takes the focus its own opening would otherwise pull.
              initialFocus={false}
              role="listbox"
              aria-label="Invoice items"
              className="max-h-60 w-(--anchor-width) overflow-y-auto rounded-lg border border-popover-border bg-popover p-1.5 text-popover-foreground outline-none"
            >
              {answer.error && answered ? (
                <p className={cn(messageClassName, "text-destructive")}>
                  {answer.error}
                </p>
              ) : !answered ? (
                <p className={messageClassName}>Searching…</p>
              ) : items.length === 0 ? (
                <p className={messageClassName}>No matching invoice items</p>
              ) : null}
              {items.map((item, index) => {
                const linkedNames = item.linkedIngredients
                  .map((ingredient) => ingredient.name)
                  .join(", ")
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={index === highlighted}
                    data-highlighted={index === highlighted || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(item)}
                    className={cn(
                      "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent",
                      index === highlighted && "bg-accent"
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {item.description}
                    </span>
                    {linkedNames ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Link2
                              className="size-[13px] shrink-0 text-muted-foreground"
                              strokeWidth={1.9}
                              role="img"
                              aria-label={`Used by ${linkedNames}`}
                            />
                          }
                        />
                        <TooltipContent>Used by {linkedNames}</TooltipContent>
                      </Tooltip>
                    ) : null}
                    <Badge
                      variant="secondary"
                      size="row"
                      // A long supplier name gives way to the description rather
                      // than truncating the one thing the cook is reading for.
                      className="max-w-[40%] shrink"
                    >
                      <span className="truncate">{item.supplier}</span>
                    </Badge>
                    <span className="shrink-0 tabular-nums">
                      {formatCents(
                        optionPackPriceCents(item),
                        item.currencyCode
                      )}
                    </span>
                  </button>
                )
              })}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

/** The three typed fields wear the same 32px box as every other short input. */
const typedFieldClassName =
  "h-9 w-full rounded-md border border-input bg-card px-3 text-md tabular-nums outline-none placeholder:text-faint hover:border-line-strong focus:border-foreground"

/** Each column repeats its heading on a narrow screen, where the row splits. */
const columnLabelClassName =
  "mb-2 block border-b border-line-strong pb-2 text-sm font-medium sm:sr-only"

/** Yield is a percent, so it needs less room than the other two. Named once so
 *  the heading row and the fields under it cannot drift apart. */
const columnsClassName = "sm:grid-cols-[1fr_1fr_0.65fr]"

/**
 * How a pack is bought: what it cost, how much of it there is, and the invoice
 * item it was read off. One set of fields behind the ingredient screen's Cost
 * section, its "Price" dialog and pricing a line from the recipe Cost tab, so
 * the three screens cannot drift into asking for different things.
 */
export function PurchaseUnitFields({
  value,
  onChange,
  onCommit,
  invoicePrices,
  allowItemSync = true,
  applyPickedInvoiceToCost = false,
  autoFocus = false,
  unitId,
  unitInvalid = false,
}: {
  value: PurchaseUnit
  onChange: (next: PurchaseUnit) => void
  /** Called with the same pack for a screen that saves as it is edited. */
  onCommit?: (next: PurchaseUnit) => void
  invoicePrices: IngredientRow["invoicePrices"]
  allowItemSync?: boolean
  /** The explicit “New ingredient with my price” recipe flow chooses this
   * invoice purchase as the starting active cost. Existing ingredients keep
   * invoice references separate until “Use for costing” is pressed. */
  applyPickedInvoiceToCost?: boolean
  /** True where these are the first fields on the screen. */
  autoFocus?: boolean
  /** Set where a form validates the unit and focuses it on failure. */
  unitId?: string
  unitInvalid?: boolean
}) {
  const { currencyCode } = useBusinessSettings()
  const fieldId = React.useId()
  const costId = `${fieldId}cost`
  const sizeId = `${fieldId}size`
  const yieldId = `${fieldId}yield`
  const [picked, setPicked] = React.useState<InvoiceLineOption | null>(null)
  // The amount field holds just the number; its unit lives in the dropdown.
  // The text is the field's own while it is being typed, so "36X1 LB" pasted
  // in, or a "200 lb" typed whole, becomes a number here and a unit beside it.
  const [amountDraft, setAmountDraft] = React.useState(() => value.size)
  const [shownPack, setShownPack] = React.useState(() => packKey(value))
  if (packKey(value) !== shownPack) {
    setShownPack(packKey(value))
    setAmountDraft(value.size)
  }

  const commit = (next: PurchaseUnit) => {
    onChange(next)
    onCommit?.(next)
  }

  /** A pack the size field itself produced, so its text needs no rewriting. */
  const typeSize = (next: PurchaseUnit) => {
    setShownPack(packKey(next))
    onChange(next)
  }

  const commitSize = (next: PurchaseUnit) => {
    setShownPack(packKey(next))
    commit(next)
  }

  const connect = (item: InvoiceLineOption) => {
    setPicked(item)
    const pack = parseTypedSize(item.packSize)
    const next: PurchaseUnit = {
      ...value,
      ...(applyPickedInvoiceToCost
        ? {
            cost: centsToDollarInput(optionPackPriceCents(item)),
            size: pack?.size ?? "",
            unit: pack?.unit ?? null,
          }
        : {}),
      invoiceLineId: item.id,
      invoicePurchaseSize: pack?.size ?? "",
      invoicePurchaseUnit: pack?.unit ?? "",
      disconnectInvoicePriceId: null,
      useInvoicePriceId: null,
    }
    onChange(next)
  }

  const disconnectedId = value.disconnectInvoicePriceId ?? null
  const usedId = value.useInvoicePriceId ?? null
  const visibleItems = invoicePrices.filter(
    (item) => item.id !== disconnectedId
  )

  const applyForCosting = (item: IngredientRow["invoicePrices"][number]) => {
    if (item.purchaseSize === null || !item.purchaseUnit) return
    const next: PurchaseUnit = {
      ...value,
      cost: centsToDollarInput(item.purchaseCostCents),
      size: String(item.purchaseSize),
      unit: item.purchaseUnit,
      invoiceLineId: null,
      disconnectInvoicePriceId: null,
      useInvoicePriceId: item.id,
    }
    setPicked(null)
    setAmountDraft(next.size)
    commitSize(next)
  }

  const disconnectItem = (itemId: string) => {
    setPicked(null)
    commit({
      ...value,
      invoiceLineId: null,
      disconnectInvoicePriceId: itemId,
      useInvoicePriceId: null,
    })
  }

  return (
    <div>
      <div className="border-b border-border pb-3">
        <div
          className={cn(
            "hidden gap-3 border-b border-line-strong pb-3 sm:grid",
            columnsClassName
          )}
        >
          <span className="text-sm font-medium">Cost ({currencyCode})</span>
          <span className="text-sm font-medium">Size</span>
          <span className="flex items-center gap-1.5 text-sm font-medium">
            Yield
            <Tooltip>
              <TooltipTrigger
                render={
                  <Info
                    className="size-[17px] text-muted-foreground"
                    strokeWidth={1.8}
                    role="img"
                    aria-label="What Yield means"
                  />
                }
              />
              <TooltipContent className="max-w-[240px]">
                Usable share after trim. 100% means no loss.
              </TooltipContent>
            </Tooltip>
          </span>
        </div>
        <div
          className={cn("grid grid-cols-1 gap-3 sm:pt-2.5", columnsClassName)}
        >
          <div className="relative min-w-0">
            <label htmlFor={costId} className={columnLabelClassName}>
              Cost ({currencyCode})
            </label>
            <input
              id={costId}
              inputMode="decimal"
              autoFocus={autoFocus}
              value={value.cost}
              placeholder="0.00"
              onChange={(event) =>
                onChange({ ...value, cost: event.target.value })
              }
              onBlur={() => onCommit?.(value)}
              className={typedFieldClassName}
            />
          </div>
          <div className="relative min-w-0">
            <label htmlFor={sizeId} className={columnLabelClassName}>
              Size
            </label>
            <div className="grid h-9 grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-md border border-input bg-card focus-within:border-foreground hover:border-line-strong">
              <input
                id={sizeId}
                type="text"
                inputMode="decimal"
                value={amountDraft}
                placeholder="–"
                autoComplete="off"
                onChange={(event) => {
                  const typed = event.target.value
                  setAmountDraft(typed)
                  const parsed = parseTypedSize(typed, value.unit)
                  if (parsed) typeSize({ ...value, ...parsed })
                  else if (typed.trim() === "") typeSize({ ...value, size: "" })
                }}
                onBlur={() => {
                  const parsed = parseTypedSize(amountDraft, value.unit)
                  if (parsed) {
                    setAmountDraft(parsed.size)
                    commitSize({ ...value, ...parsed })
                  } else if (amountDraft.trim() === "") {
                    commitSize({ ...value, size: "" })
                  } else {
                    onCommit?.(value)
                  }
                }}
                className="min-w-0 bg-transparent px-3 text-md tabular-nums outline-none placeholder:text-faint"
              />
              <UnitCombobox
                id={unitId}
                label="Size"
                invalid={unitInvalid}
                value={value.unit || null}
                onChange={(unit) => commitSize({ ...value, unit: unit ?? "" })}
                options={PURCHASE_UNITS}
                variant="chip"
                className="mr-1"
                popupClassName="w-[205px]"
              />
            </div>
          </div>
          <div className="relative min-w-0">
            <label htmlFor={yieldId} className={columnLabelClassName}>
              Yield
            </label>
            <div className="relative">
              <input
                id={yieldId}
                inputMode="decimal"
                value={value.yieldPercent}
                placeholder="100"
                onChange={(event) =>
                  onChange({ ...value, yieldPercent: event.target.value })
                }
                onBlur={() => onCommit?.(value)}
                className={cn(typedFieldClassName, "pr-7")}
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground"
              >
                %
              </span>
            </div>
          </div>
        </div>
      </div>

      {allowItemSync ? (
        <div className="mt-4 overflow-hidden rounded-xl border border-border">
          <div className="flex h-8 items-center justify-between gap-3 bg-muted px-3.5 text-xs font-medium text-muted-foreground">
            <span>Invoice prices</span>
            <span className="tabular-nums">
              {visibleItems.length} connected
            </span>
          </div>

          {visibleItems.length > 0 ? (
            <div className="divide-y divide-muted">
              {visibleItems.map((item) => {
                const used = usedId ? item.id === usedId : item.isUsedForCosting
                return (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center gap-3 px-3.5 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-base font-medium">
                          {item.title}
                        </span>
                        {used ? (
                          <Badge size="row">Used for costing</Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-faint">
                        {item.supplier} {item.externalId} ·{" "}
                        {item.rawSize ||
                          `${item.purchaseSize ?? "–"} ${unitShort(item.purchaseUnit)}`}{" "}
                        ·{" "}
                        {formatCents(item.purchaseCostCents, item.currencyCode)}
                        {item.invoiceDate
                          ? ` · ${invoiceDateFormat.format(new Date(item.invoiceDate))}`
                          : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {!used ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={
                            item.purchaseSize === null || !item.purchaseUnit
                          }
                          onClick={() => applyForCosting(item)}
                        >
                          Use for costing
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => disconnectItem(item.id)}
                      >
                        Disconnect
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="px-3.5 py-3 text-xs text-muted-foreground">
              No invoice prices connected yet.
            </p>
          )}

          {picked ? (
            <div className="border-t border-muted bg-fill-soft px-3.5 py-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[180px] flex-1 pb-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {picked.description}
                  </span>
                  <br />
                  {picked.supplier} ·{" "}
                  {formatCents(
                    optionPackPriceCents(picked),
                    picked.currencyCode
                  )}
                  {picked.invoiceDate
                    ? ` · ${invoiceDateFormat.format(new Date(picked.invoiceDate))}`
                    : ""}
                </div>
                <div className="w-24">
                  <LabeledInput
                    label="Pack size"
                    inputMode="decimal"
                    value={value.invoicePurchaseSize ?? ""}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        invoicePurchaseSize: event.target.value,
                      })
                    }
                  />
                </div>
                <UnitCombobox
                  label="Pack"
                  value={value.invoicePurchaseUnit || null}
                  onChange={(unit) =>
                    onChange({
                      ...value,
                      invoicePurchaseUnit: unit ?? "",
                    })
                  }
                  options={PURCHASE_UNITS}
                  className="w-28"
                />
                <Button
                  type="button"
                  size="default"
                  disabled={
                    !value.invoicePurchaseSize || !value.invoicePurchaseUnit
                  }
                  onClick={() => {
                    const next = {
                      ...value,
                      invoiceLineId: picked.id,
                      disconnectInvoicePriceId: null,
                      useInvoicePriceId: null,
                    }
                    setPicked(null)
                    commit(next)
                  }}
                >
                  Add price
                </Button>
              </div>
            </div>
          ) : null}

          <div className="border-t border-muted p-3.5">
            <InvoiceItemSearch onPick={connect} />
          </div>
        </div>
      ) : null}

      {value.disconnectInvoicePriceId ? (
        <p className="mt-2 text-xs text-muted-foreground">
          The cost above stays as it is. Saving only drops the link to the
          invoice item, and price history is kept.
        </p>
      ) : null}
    </div>
  )
}
