"use client"

import * as React from "react"
import { CircleAlert, Plus, Search, X } from "lucide-react"

import {
  adoptCatalogPrice,
  adoptMasterPrice,
  dismissMasterPrice,
  linkInvoiceItem,
  saveIngredient,
  saveRecipeLineMatch,
  searchCatalogPrices,
  type CatalogPriceSuggestion,
} from "@/app/(app)/ingredients/actions"

import { useBusinessSettings } from "@/components/business-settings-provider"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import {
  EMPTY_PURCHASE_UNIT,
  PurchaseUnitFields,
  type PurchaseUnit,
} from "@/components/ingredients/purchase-unit-fields"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { LabeledInput } from "@/components/ui/labeled-field"
import { Input } from "@/components/ui/input"
import {
  MISSING_PURCHASE_PRICE,
  parsePurchaseUnit,
  savePurchaseUnit,
} from "@/lib/ingredients/save-purchase-unit"
import { centsToDollarInput, formatCents } from "@/lib/money"
import { preferredWeightUnit } from "@/lib/business-settings"
import type { WeightUnit } from "@/lib/units"
import {
  normalizeIngredientName,
  formatUnitPrice,
  type PriceListEntry,
} from "@/lib/pricing"
import { rankedIngredientMatches } from "@/lib/search"

export type PriceLineMatch = {
  line: string
  entry: PriceListEntry
  replacedMasterPriceId?: string
}

/** Where a price comes from, as the small grey chip beside its name. */
function entryTag(entry: PriceListEntry): string {
  if (entry.source === "catalog" || entry.source === "master") return "Estimate"
  if (entry.source === "component") return "Recipe"
  return "Pantry"
}

/** What one of these costs — per piece when that is the only way it prices. */
function entryPrice(
  entry: PriceListEntry,
  unit: WeightUnit,
  currencyCode: string
): string {
  const pieces = entry.componentYieldAmount
  if (
    entry.source === "component" &&
    entry.componentYieldUnit === "pcs" &&
    !entry.componentWeightKnown &&
    pieces !== null &&
    pieces !== undefined &&
    Number.isFinite(pieces) &&
    pieces > 0
  ) {
    return `${formatCents(entry.purchaseCostCents / pieces, currencyCode)} / pc`
  }
  return `${formatUnitPrice(entry.purchaseCostCents, entry.purchaseSize, entry.purchaseUnit, unit, currencyCode)} / ${unit}`
}

/**
 * Whether this row can cost anything yet. A pantry ingredient nobody has
 * priced shows a dash where its unit price goes, and linking a line to it
 * leaves the line as unpriced as it was, so it is asked for a pack first.
 */
function hasUsablePrice(entry: PriceListEntry): boolean {
  return (
    entry.purchaseCostCents > 0 &&
    Boolean(entry.purchaseUnit) &&
    (entry.purchaseSize ?? 0) > 0
  )
}

/** The rows that are an ingredient in the pantry rather than an estimate. */
function isPantry(entry: PriceListEntry): boolean {
  return entry.source === undefined || entry.source === "pantry"
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex-none rounded-sm bg-muted px-[7px] py-0.5 text-2xs font-medium text-muted-foreground">
      {children}
    </span>
  )
}

/** A 40px full-width choice, the shape the handoff gives these two actions. */
function ChoiceButton({
  icon,
  children,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 w-full items-center gap-2.5 rounded-md border border-input bg-card px-3 text-left text-base font-medium text-foreground outline-none focus-visible:border-foreground enabled:hover:border-line-strong disabled:cursor-not-allowed disabled:text-disabled-foreground"
    >
      {icon}
      {children}
    </button>
  )
}

const NEW_NAME_FIELD = "new-ingredient-name"

/** The pack fields, which carry no id of their own. */
const PURCHASE_FIELD = "price-line-purchase"

function PickerBody({
  lineName,
  priceList,
  linked,
  onLinked,
  onDone,
  onDirtyChange,
}: {
  lineName: string
  priceList: PriceListEntry[]
  linked?: PriceListEntry | null
  onLinked?: (match: PriceLineMatch) => void
  onDone: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const { currencyCode, measurementSystem } = useBusinessSettings()
  const unitPriceUnit = preferredWeightUnit(measurementSystem)
  const [query, setQuery] = React.useState(lineName)
  const [mode, setMode] = React.useState<"pick" | "create">("pick")
  const [selected, setSelected] = React.useState<PriceListEntry | null>(null)
  // A line already matched to a pantry row has nothing to search for: which
  // ingredient it is belongs to the recipe, and only the price is asked here.
  const linkedPantry = linked && isPantry(linked) ? linked : null
  // The pantry row being priced, waiting for a pack.
  const [pricing, setPricing] = React.useState<PriceListEntry | null>(
    linkedPantry
  )
  const seedPurchase = (): PurchaseUnit =>
    linkedPantry && hasUsablePrice(linkedPantry)
      ? {
          ...EMPTY_PURCHASE_UNIT,
          cost: centsToDollarInput(linkedPantry.purchaseCostCents),
          size: String(linkedPantry.purchaseSize ?? ""),
          unit: linkedPantry.purchaseUnit ?? null,
          yieldPercent: String(linkedPantry.yieldPercent ?? 100),
        }
      : EMPTY_PURCHASE_UNIT
  const [purchase, setPurchase] = React.useState<PurchaseUnit>(seedPurchase)
  const [newName, setNewName] = React.useState("")
  const [entered] = React.useState(() => JSON.stringify([seedPurchase(), ""]))
  // Keyed by the search that produced them, so a result never outlives the
  // query it answered.
  const [catalog, setCatalog] = React.useState<{
    query: string
    items: CatalogPriceSuggestion[]
  }>({ query: "", items: [] })
  // The catalog search and the estimate it can hide report here; the three
  // save flows report through the form.
  const [notice, setNotice] = React.useState<string | null>(null)
  const [hiding, setHiding] = React.useState(false)

  const search = query.trim()
  const catalogResults =
    mode === "pick" && catalog.query === search ? catalog.items : []
  // Best match first rather than pantry order.
  const localMatches = rankedIngredientMatches(priceList, query)
  const visibleCatalogResults = catalogResults.filter(
    (catalog) =>
      !localMatches.some(
        (entry) => entry.catalogPriceId === catalog.catalogPriceId
      )
  )

  // Once the server says the quota is spent, further requests only extend
  // the outage the error already reports. Other failures still retry on the
  // next edit.
  const backoffUntil = React.useRef(0)

  // The catalog lives on the server and is rate limited, so it trails the
  // typing rather than firing on every keystroke.
  React.useEffect(() => {
    if (mode !== "pick" || search.length < 3) return
    let cancelled = false
    const timer = setTimeout(async () => {
      if (Date.now() < backoffUntil.current) return
      const result = await searchCatalogPrices(search)
      if (cancelled) return
      if ("error" in result) {
        if (result.error.startsWith("Too many Catalog requests")) {
          backoffUntil.current = Date.now() + 15_000
        }
        setNotice(result.error)
      } else {
        setNotice(null)
        setCatalog({ query: search, items: result.items })
      }
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search, mode])

  const dirty = JSON.stringify([purchase, newName]) !== entered
  React.useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  /** Points the line at an ingredient and tells the caller what it now costs. */
  const linkTo = async (entry: PriceListEntry) => {
    const result = await saveRecipeLineMatch(lineName, entry.id, "ingredient")
    if ("error" in result) throw new Error(result.error)
    onLinked?.({ line: normalizeIngredientName(lineName), entry })
  }

  const form = useFormSave({
    snapshot: JSON.stringify([
      mode,
      selected?.id,
      pricing?.id,
      purchase,
      newName,
    ]),
    // Every step here writes, whether or not a field on it was touched.
    saved: false,
    validate: (): FormErrors => {
      if (selected) return {}
      if (!pricing && !newName.trim()) {
        return { [NEW_NAME_FIELD]: "Name is required." }
      }
      return parsePurchaseUnit(purchase)
        ? {}
        : { [PURCHASE_FIELD]: MISSING_PURCHASE_PRICE }
    },
    save: async () => {
      if (pricing) {
        const price = parsePurchaseUnit(purchase)!
        const saved = await savePurchaseUnit({
          id: pricing.id,
          unit: purchase,
        })
        if ("error" in saved) throw new Error(saved.error)
        await linkTo({ ...pricing, source: "pantry", ...price })
        return null
      }
      if (selected) {
        let targetId = selected.id
        let targetKind: "ingredient" | "recipe" =
          selected.source === "component" ? "recipe" : "ingredient"
        if (selected.source === "catalog") {
          if (!selected.catalogPriceId)
            throw new Error("Catalog estimate is unavailable")
          const adopted = await adoptCatalogPrice(selected.catalogPriceId)
          if ("error" in adopted) throw new Error(adopted.error)
          targetId = adopted.id
          targetKind = "ingredient"
        } else if (selected.source === "master") {
          if (!selected.masterPriceId)
            throw new Error("Estimate is unavailable")
          const adopted = await adoptMasterPrice(selected.masterPriceId)
          if ("error" in adopted) throw new Error(adopted.error)
          targetId = adopted.id
          targetKind = "ingredient"
        }
        const result = await saveRecipeLineMatch(lineName, targetId, targetKind)
        if ("error" in result) throw new Error(result.error)
        onLinked?.({
          line: normalizeIngredientName(lineName),
          entry:
            selected.source === "master" || selected.source === "catalog"
              ? {
                  ...selected,
                  id: targetId,
                  source: "pantry",
                  masterPriceId: undefined,
                  catalogPriceId: undefined,
                }
              : selected,
          replacedMasterPriceId: selected.masterPriceId,
        })
        return null
      }
      const name = newName.trim()
      const price = parsePurchaseUnit(purchase)!
      const created = await saveIngredient({ id: null, name, ...price })
      if ("error" in created) throw new Error(created.error)
      // The ingredient has to exist before an invoice item can point at it,
      // so the link is its own call and the price travels with it.
      if (purchase.invoiceLineId) {
        const linked = await linkInvoiceItem(
          created.id,
          purchase.invoiceLineId,
          {
            purchaseSize: Number(purchase.invoicePurchaseSize),
            purchaseUnit: purchase.invoicePurchaseUnit ?? "",
          }
        )
        if ("error" in linked) throw new Error(linked.error)
      }
      await linkTo({
        id: created.id,
        name,
        normalizedName: normalizeIngredientName(name),
        source: "pantry",
        ...price,
      })
      return null
    },
  })

  const submit = () =>
    void form.submit().then((done) => {
      if (done) onDone()
    })

  const problem =
    form.errors[NEW_NAME_FIELD] ??
    form.errors[PURCHASE_FIELD] ??
    form.failure?.message ??
    notice

  const hideSelectedEstimate = async () => {
    if (!selected?.masterPriceId) return
    setHiding(true)
    setNotice(null)
    const result = await dismissMasterPrice(selected.masterPriceId)
    if ("error" in result) {
      setNotice(result.error)
      setHiding(false)
      return
    }
    onDone()
  }

  // A pantry row with nothing to cost by is asked what it was bought as
  // before the line is pointed at it; everything else confirms as before.
  const choose = (entry: PriceListEntry) => {
    if (isPantry(entry) && !hasUsablePrice(entry)) {
      setPurchase(EMPTY_PURCHASE_UNIT)
      setNotice(null)
      setPricing(entry)
      return
    }
    setSelected(entry)
  }

  if (pricing) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(event) => {
          dialogSaveShortcut(submit)(event)
          if (event.key !== "Enter" || form.pending) return
          event.preventDefault()
          submit()
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PurchaseUnitFields
            value={purchase}
            onChange={setPurchase}
            invoicePrices={[]}
            autoFocus
          />
          {problem ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          {pricing === linkedPantry ? null : (
            <Button variant="outline" onClick={() => setPricing(null)}>
              Back
            </Button>
          )}
          <Button pending={form.pending} onClick={submit}>
            Save price
          </Button>
        </div>
      </div>
    )
  }

  if (selected) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-fill-soft px-3.5 py-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-md">{selected.name}</span>
              <Tag>{entryTag(selected)}</Tag>
            </span>
            <span className="flex-none text-base text-muted-foreground tabular-nums">
              {entryPrice(selected, unitPriceUnit, currencyCode)}
            </span>
          </div>
          <p className="mt-4 text-sm font-medium">
            Use this match across your account?
          </p>
          <p className="mt-1 text-xs leading-[1.55] text-muted-foreground">
            Confirming teaches every recipe that “{lineName}” means “
            {selected.name}”. Nothing is linked until you confirm.
          </p>
          {problem ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {selected.source === "master" ? (
            <Button
              variant="ghost"
              className="mr-auto text-foreground"
              pending={hiding}
              onClick={() => void hideSelectedEstimate()}
            >
              Don’t suggest this estimate
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => setSelected(null)}>
            Back
          </Button>
          <Button pending={form.pending} onClick={submit}>
            Use this match
          </Button>
        </div>
      </div>
    )
  }

  if (mode === "create") {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(event) => {
          dialogSaveShortcut(submit)(event)
          if (event.key !== "Enter" || form.pending) return
          event.preventDefault()
          submit()
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          <p className="text-xs leading-[1.55] text-muted-foreground">
            Saving adds your price and remembers this line name for every recipe
            in your account.
          </p>
          <div className="mt-4">
            <LabeledInput
              label="Name (required)"
              id={NEW_NAME_FIELD}
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </div>
          <div className="mt-4">
            <PurchaseUnitFields
              value={purchase}
              onChange={setPurchase}
              invoicePrices={[]}
              applyPickedInvoiceToCost
            />
          </div>
          {problem ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setMode("pick")}>
            Back to matches
          </Button>
          <Button pending={form.pending} onClick={submit}>
            Save
          </Button>
        </div>
      </div>
    )
  }

  const entries = [...localMatches, ...visibleCatalogResults]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-[15px] -translate-y-1/2 text-faint"
          strokeWidth={2}
          aria-hidden="true"
        />
        <Input
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          aria-label="Search pricing choices"
          className="pr-[34px] pl-[33px]"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear"
            onClick={() => setQuery("")}
            className="absolute top-1/2 right-2 flex size-[22px] -translate-y-1/2 items-center justify-center rounded-md border border-transparent text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:border-foreground"
          >
            <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* The matches keep the whole middle, so an empty result leaves the
          dialog the size it was. */}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="flex items-center gap-2.5 rounded-lg border border-border bg-fill-soft px-3.5 py-3">
            <CircleAlert
              className="size-4 shrink-0 text-faint"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className="text-sm text-muted-foreground">
              No match in your ingredients yet
            </span>
          </div>
        ) : (
          <div className="rounded-lg border border-border">
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => choose(entry)}
                className="flex w-full items-center justify-between gap-3 border-b border-muted px-3.5 py-[11px] text-left outline-none last:border-b-0 hover:bg-fill-soft focus-visible:bg-fill-soft"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-md">{entry.name}</span>
                  <Tag>{entryTag(entry)}</Tag>
                </span>
                <span className="flex-none text-base text-muted-foreground tabular-nums">
                  {entryPrice(entry, unitPriceUnit, currencyCode)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {problem ? (
        <p className="mt-3 text-xs text-destructive" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="mt-3 flex shrink-0 flex-col gap-2">
        <ChoiceButton
          onClick={() => {
            setNewName(search || lineName)
            setPurchase(EMPTY_PURCHASE_UNIT)
            setNotice(null)
            setMode("create")
          }}
          icon={
            <Plus
              className="size-4 text-muted-foreground"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          }
        >
          New ingredient with my price
        </ChoiceButton>
      </div>
    </div>
  )
}

/**
 * "Price {line}": the modal a recipe line opens when it has no price yet.
 * Search the pantry, fall back to the catalog, or create the ingredient with
 * your own price. Nothing is linked account-wide until it is confirmed.
 *
 * A line already matched to an unpriced pantry row skips the search: it opens
 * on that ingredient's Price form; which ingredient a line is belongs to the
 * recipe editor, so there is no way back to the search from there.
 */
export function PriceLineDialog({
  lineName,
  priceList,
  linked,
  onLinked,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  lineName: string
  priceList: PriceListEntry[]
  /** The entry this line is already matched to, when it has one. A pantry
   *  match opens its Price form instead of the search. */
  linked?: PriceListEntry | null
  onLinked?: (match: PriceLineMatch) => void
  /** `null` mounts the dialog with no trigger, for callers that open it
   *  from somewhere else entirely. */
  trigger?: React.ReactElement | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen
  const [dirty, setDirty] = React.useState(false)
  const { confirm, dialog } = useDirtyDialog()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true)
        else confirm(dirty, () => setOpen(false))
      }}
    >
      {trigger ? (
        <DialogTrigger render={trigger} />
      ) : trigger === null ? null : (
        <DialogTrigger
          render={
            <button
              type="button"
              className="text-primary underline-offset-4 outline-none hover:underline"
            />
          }
        >
          add price
        </DialogTrigger>
      )}
      {/* One fixed height: searching, or stepping to the price form, moves
          the body, never the dialog. Only the body region scrolls. */}
      <DialogContent size="md" className="flex h-[min(560px,85dvh)] flex-col">
        <DialogHeader>
          <DialogTitle>Price {lineName}</DialogTitle>
        </DialogHeader>
        {open ? (
          <PickerBody
            lineName={lineName}
            priceList={priceList}
            linked={linked}
            onLinked={onLinked}
            onDone={() => setOpen(false)}
            onDirtyChange={setDirty}
          />
        ) : null}
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
