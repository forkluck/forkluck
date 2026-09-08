"use client"

import * as React from "react"
import { ExternalLink, Trash2, TriangleAlert } from "lucide-react"

import { reviewInvoiceLine, saveInvoice } from "@/app/(app)/invoices/actions"
import { useInvoiceEdit } from "@/components/invoices/invoice-chrome"
import {
  LineCostFields,
  type LineCostValue,
} from "@/components/invoices/line-cost-fields"
import { SupplierCombobox } from "@/components/invoices/supplier-combobox"
import { useBusinessSettings } from "@/components/business-settings-provider"
import type { IngredientOption } from "@/components/ingredients/types"
import { AddButton } from "@/components/ui/add-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DateField } from "@/components/ui/date-field"
import {
  LabeledInput,
  LabeledShell,
  labeledControlClassName,
} from "@/components/ui/labeled-field"
import { Input } from "@/components/ui/input"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { SaveBanner } from "@/components/ui/save-banner"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toast"
import { useDocumentSave, type SaveEcho } from "@/hooks/use-document-save"
import { invoiceDraft } from "@/lib/draft-store"
import {
  invoiceLinePackPriceCents,
  resolveInvoiceLinePack,
} from "@/lib/invoice-line-cost"
import { toSaveFailure, type SaveFailure } from "@/lib/save-failure"
import type { ExpenseCategoryRow } from "@/lib/backend/types"
import type { InvoiceDetail, InvoicePaymentMethod } from "@/lib/backend/schemas"
import { centsToDollarInput, dollarsToCents, formatCents } from "@/lib/money"
import { cn } from "@/lib/utils"
import { useGuardedNavigate } from "@/components/navigation-blocker"

/** The wire values every workspace has. A workspace's own methods are stored
 *  under their own names, so those are their own labels. */
const BUILT_IN_PAYMENT_METHODS: Array<{ value: string; label: string }> = [
  { value: "", label: "No payment method" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "on_account", label: "On account" },
]

const cellInput =
  "h-8 rounded-md border-transparent bg-transparent px-2 text-base md:text-base enabled:not-focus:hover:border-transparent"

type LineState = {
  key: string
  id?: string | null
  description: string
  sku: string
  quantity: string
  /** No unit column: an edit passes back whatever the line already carried. */
  unit: string
  /** Original printed pack, kept even though the editor shows parsed fields. */
  packSize: string
  unitPrice: string
  amount: string
  /** Once the amount is typed, qty × unit price stops overwriting it. */
  amountTouched: boolean
  categoryId: string
  cost: LineCostValue
  /** Imported lines the extractor could not place; only these offer Review. */
  needsReview: boolean
}

const newKey = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

function emptyLine(): LineState {
  return {
    key: newKey(),
    id: null,
    description: "",
    sku: "",
    quantity: "",
    unit: "",
    packSize: "",
    unitPrice: "",
    amount: "",
    amountTouched: false,
    categoryId: "",
    cost: { ingredientId: "", name: "", amount: "", unit: "lb", price: "" },
    needsReview: false,
  }
}

function lineState(line: InvoiceDetail["lines"][number]): LineState {
  const suggestedPack = line.needsReview ? resolveInvoiceLinePack(line) : null
  const suggestedPriceCents = line.needsReview
    ? invoiceLinePackPriceCents(line)
    : null
  return {
    key: line.id,
    id: line.id,
    description: line.description,
    sku: line.sku,
    quantity: line.quantity === null ? "" : String(line.quantity),
    unit: line.unit,
    packSize: line.packSize,
    unitPrice:
      line.unitPriceCents === null
        ? ""
        : centsToDollarInput(line.unitPriceCents),
    amount: centsToDollarInput(line.lineAmountCents),
    amountTouched: true,
    categoryId: line.categoryId ?? "",
    cost: {
      ingredientId: line.ingredientId ?? "",
      name: line.ingredientName || line.description,
      amount: suggestedPack ? String(suggestedPack.amount) : "",
      unit: suggestedPack?.unit ?? "lb",
      price:
        suggestedPriceCents !== null && suggestedPriceCents > 0
          ? centsToDollarInput(suggestedPriceCents)
          : "",
    },
    needsReview: line.needsReview,
  }
}

/** yyyy-mm-dd in the browser's own day, which is the day being invoiced. */
function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${now.getFullYear()}-${month}-${day}`
}

function amountFrom(quantity: string, unitPrice: string): string {
  const qty = Number(quantity)
  const price = dollarsToCents(unitPrice)
  if (!quantity.trim() || !Number.isFinite(qty) || price === null) return ""
  return centsToDollarInput(Math.round(qty * price))
}

function categoryIsIngredient(
  categories: ExpenseCategoryRow[],
  categoryId: string
): boolean {
  return categories.some(
    (category) => category.id === categoryId && category.isIngredient
  )
}

/** A line nobody filled in: dropped rather than saved as a blank row. */
function isEmptyLine(line: LineState): boolean {
  return !line.description.trim() && dollarsToCents(line.amount) === null
}

/** Nothing typed into it at all: what the trailing row looks like at rest. */
function isBlankLine(line: LineState): boolean {
  return (
    !line.description.trim() &&
    !line.quantity.trim() &&
    !line.unitPrice.trim() &&
    !line.amount.trim() &&
    !line.categoryId
  )
}

/** The table always ends in one blank row; typing into it starts a line. */
function withTrailingBlank(rows: LineState[]): LineState[] {
  const last = rows[rows.length - 1]
  return last && isBlankLine(last) ? rows : [...rows, emptyLine()]
}

function costEntryOf(line: LineState, ingredients: IngredientOption[]) {
  const packAmount = Number(line.cost.amount)
  const packPriceCents = dollarsToCents(line.cost.price)
  if (!line.cost.amount.trim() || !Number.isFinite(packAmount)) return null
  if (packAmount <= 0 || packPriceCents === null || packPriceCents <= 0) {
    return null
  }
  // A name travels with the price, so a picked pantry match keeps its own name
  // rather than being renamed to whatever the supplier printed.
  const matched = line.cost.ingredientId
    ? ingredients.find((ingredient) => ingredient.id === line.cost.ingredientId)
    : undefined
  const quantity = Number(line.quantity)
  return {
    name: matched?.name ?? (line.cost.name.trim() || line.description.trim()),
    packUnit: line.cost.unit,
    packAmount,
    packPriceCents,
    rawSize: line.packSize || `${packAmount} ${line.cost.unit}`,
    quantity:
      line.quantity.trim() && Number.isFinite(quantity) && quantity > 0
        ? quantity
        : null,
    preferred: false,
    ingredientId: line.cost.ingredientId || null,
  }
}

const snapshotOf = (header: unknown[], lines: readonly LineState[]): string =>
  JSON.stringify([
    header,
    lines.map((line) => [
      line.description,
      line.quantity,
      line.unitPrice,
      line.amount,
      line.categoryId,
      line.cost,
    ]),
  ])

/** One right-aligned figure under the table. */
function TotalLine({
  label,
  value,
  strong,
}: {
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div className="flex justify-between gap-6 py-1">
      <span className={cn("text-base", strong && "font-medium")}>{label}</span>
      <span
        className={cn(
          "tabular text-base whitespace-nowrap",
          strong && "font-medium"
        )}
      >
        {value}
      </span>
    </div>
  )
}

/** What a recovered draft puts back, which is what `invoiceDraft` allowed out. */
type InvoiceRecovery = {
  supplierName: string
  invoiceDate: string
  dueDate: string
  invoiceNumber: string
  paymentMethod: string
  subtotal: string
  tax: string
  total: string
  notes: string
  lines: LineState[]
}

export function InvoiceEditor({
  initial,
  supplierNames,
  ingredients,
  categories,
  paymentMethods,
  currentUserId,
}: {
  initial: InvoiceDetail | null
  supplierNames: string[]
  ingredients: IngredientOption[]
  categories: ExpenseCategoryRow[]
  /** The workspace's own methods, offered under the four built-ins. */
  paymentMethods: Array<{ id: string; name: string }>
  currentUserId: string
}) {
  const { go } = useGuardedNavigate()
  const toast = useToast()
  const settings = useBusinessSettings()
  const { saveRef, dirty, setDirty, setSaveState } = useInvoiceEdit()

  const imported = initial !== null && initial.source !== "manual"
  const currencyCode = initial?.currencyCode || settings.currencyCode

  const [invoiceId, setInvoiceId] = React.useState(initial?.id ?? null)
  // A queued save reads this, not the render closure, so it never re-creates.
  const invoiceIdRef = React.useRef(invoiceId)
  const [supplierName, setSupplierName] = React.useState(
    initial?.supplierName ?? ""
  )
  const [invoiceDate, setInvoiceDate] = React.useState(
    initial ? (initial.invoiceDate ?? "") : today()
  )
  const [dueDate, setDueDate] = React.useState(initial?.dueDate ?? "")
  const [invoiceNumber, setInvoiceNumber] = React.useState(
    initial?.invoiceNumber ?? ""
  )
  const [paymentMethod, setPaymentMethod] =
    React.useState<InvoicePaymentMethod>(initial?.paymentMethod ?? "")
  const [subtotal, setSubtotal] = React.useState(
    initial?.subtotalCents == null
      ? ""
      : centsToDollarInput(initial.subtotalCents)
  )
  const [tax, setTax] = React.useState(
    initial ? centsToDollarInput(initial.taxCents) : ""
  )
  const [total, setTotal] = React.useState(
    initial ? centsToDollarInput(initial.totalCents) : ""
  )
  const [notes, setNotes] = React.useState(initial?.notes ?? "")
  const [lines, setLines] = React.useState<LineState[]>(() =>
    withTrailingBlank(initial ? initial.lines.map(lineState) : [])
  )
  const savedLineIds = React.useRef(
    new Map(initial?.lines.map((line) => [line.id, line.id]))
  )
  const blankDescriptionRef = React.useRef<HTMLInputElement>(null)

  const paymentOptions = React.useMemo(
    () => [
      ...BUILT_IN_PAYMENT_METHODS,
      ...paymentMethods.map((method) => ({
        value: method.name,
        label: method.name,
      })),
    ],
    [paymentMethods]
  )
  const paymentLabels = React.useMemo(
    () =>
      Object.fromEntries(
        paymentOptions.map((option) => [option.value, option.label])
      ),
    [paymentOptions]
  )

  const categoryOptions = React.useMemo(
    () => [
      { value: "", label: "No category" },
      ...categories.map((category) => ({
        value: category.id,
        label: category.name,
      })),
    ],
    [categories]
  )
  // The trigger reads a bare id unless the values are mapped to their labels.
  const categoryLabels = React.useMemo(
    () =>
      Object.fromEntries(
        categoryOptions.map((option) => [option.value, option.label])
      ),
    [categoryOptions]
  )

  const snapshot = snapshotOf(
    [
      supplierName,
      invoiceDate,
      dueDate,
      invoiceNumber,
      paymentMethod,
      subtotal,
      tax,
      total,
      notes,
    ],
    lines
  )

  const patchLine = (key: string, patch: Partial<LineState>) => {
    setLines((current) =>
      withTrailingBlank(
        current.map((line) => {
          if (line.key !== key) return line
          const next = { ...line, ...patch }
          if ("amount" in patch) next.amountTouched = true
          else if (!next.amountTouched) {
            next.amount = amountFrom(next.quantity, next.unitPrice)
          }
          return next
        })
      )
    )
  }

  /** What the open review block holds. Its own state, not the line's: filing
   *  a line is a write of its own and must not make the document dirty. */
  const [review, setReview] = React.useState<{
    key: string
    categoryId: string
    cost: LineCostValue
  } | null>(null)
  const [reviewSaving, setReviewSaving] = React.useState(false)

  // Resolving one line writes that line on its own, then replaces every line
  // with the server's answer — which is why Review is offered only on a clean
  // form: on a dirty one it would throw the unsaved edits away.
  const saveReview = async (line: LineState) => {
    if (!review) return
    setReviewSaving(true)
    const result = await reviewInvoiceLine({
      lineId: line.key,
      categoryId: review.categoryId || null,
      costEntry: categoryIsIngredient(categories, review.categoryId)
        ? costEntryOf(
            { ...line, categoryId: review.categoryId, cost: review.cost },
            ingredients
          )
        : null,
    })
    if ("error" in result) {
      setReviewSaving(false)
      toast.add({
        title: "Couldn’t save that line",
        description: result.error,
        type: "error",
      })
      return
    }
    setLines(result.item.lines.map(lineState))
    setReview(null)
    setReviewSaving(false)
  }

  // What the lines themselves add up to: the arithmetic check, which is not
  // the subtotal the document printed.
  const lineSumCents = lines.reduce(
    (sum, line) => sum + (dollarsToCents(line.amount) ?? 0),
    0
  )
  const taxCents = dollarsToCents(tax) ?? 0
  const totalCents = dollarsToCents(total) ?? 0
  const mismatch = lineSumCents + taxCents !== totalCents

  const save = async (
    expectedEditVersion: number | null,
    leaving: boolean
  ): Promise<SaveEcho | SaveFailure> => {
    if (!supplierName.trim()) {
      toast.add({ title: "Name the supplier", type: "error" })
      return { kind: "validation", message: "Name the supplier" }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
      toast.add({ title: "Give the invoice a date", type: "error" })
      return { kind: "validation", message: "Give the invoice a date" }
    }
    const sentLines = lines.filter((line) => !isEmptyLine(line))
    const result = await saveInvoice({
      ...(invoiceIdRef.current ? { id: invoiceIdRef.current } : {}),
      ...(expectedEditVersion === null ? {} : { expectedEditVersion }),
      supplierName: supplierName.trim(),
      invoiceNumber: invoiceNumber.trim(),
      invoiceDate,
      dueDate: dueDate.trim() || null,
      totalCents: dollarsToCents(total) ?? 0,
      taxCents: dollarsToCents(tax) ?? 0,
      subtotalCents: dollarsToCents(subtotal),
      notes,
      paymentMethod,
      lines: sentLines.map((line) => {
        const quantity = Number(line.quantity)
        const costEntry = categoryIsIngredient(categories, line.categoryId)
          ? costEntryOf(line, ingredients)
          : null
        return {
          id: savedLineIds.current.get(line.key) ?? line.id ?? null,
          description: line.description.trim(),
          quantity:
            line.quantity.trim() && Number.isFinite(quantity) ? quantity : null,
          unit: line.unit,
          packSize: line.packSize,
          sku: line.sku,
          unitPriceCents: dollarsToCents(line.unitPrice),
          lineAmountCents: dollarsToCents(line.amount) ?? 0,
          categoryId: line.categoryId || null,
          costEntry,
          // A line the import left unresolved stays unresolved until this
          // save resolves it: a priced match, or filing it under a category
          // that is not an ingredient one. Fixing a typo elsewhere is not a
          // review.
          needsReview:
            line.needsReview &&
            costEntry === null &&
            (!line.categoryId ||
              categoryIsIngredient(categories, line.categoryId)),
        }
      }),
    })
    if ("error" in result) return toSaveFailure(result)
    sentLines.forEach((line, index) => {
      const saved = result.item.lines[index]
      if (saved) savedLineIds.current.set(line.key, saved.id)
    })
    const creating = invoiceIdRef.current === null
    if (creating) {
      invoiceIdRef.current = result.item.id
      setInvoiceId(result.item.id)
    }
    // Leaving: rewrite the entry being left, never navigate.
    if (leaving) {
      if (creating)
        window.history.replaceState(
          null,
          "",
          `/invoices/${result.item.publicId}`
        )
      return { editVersion: result.item.editVersion }
    }
    if (creating) void go(`/invoices/${result.item.publicId}`, { force: true })
    return { editVersion: result.item.editVersion }
  }

  const { saveNow, conflict, restorable, dismissRestore, discardDraft } =
    useDocumentSave({
      snapshot,
      // An invoice saves when the cook asks, or on the way off the page.
      active: false,
      wholeForm: true,
      kind: "invoice",
      workspaceId: currentUserId,
      userId: currentUserId,
      recordId: invoiceId,
      editVersion: initial?.editVersion ?? null,
      payload: () =>
        invoiceDraft({
          supplierName,
          invoiceDate,
          dueDate,
          invoiceNumber,
          paymentMethod,
          subtotal,
          tax,
          total,
          notes,
          lines: lines.map((line) => ({
            ...line,
            id: savedLineIds.current.get(line.key) ?? line.id ?? null,
          })),
        }),
      setDirty,
      setSaveState,
      save,
    })

  /** The same save, out loud: the header's Save button calls this. */
  const saveOnRequest = async () => {
    const failure = await saveNow()
    // A validation failure has already named the field it stopped on.
    if (!failure || failure.kind === "validation") return
    toast.add({
      title: "Couldn’t save",
      description: failure.message,
      type: "error",
    })
  }

  React.useEffect(() => {
    saveRef.current = saveOnRequest
    return () => {
      saveRef.current = null
    }
  })

  /** Put a recovered draft back on the screen, field for field. */
  const applyRecovery = (recovery: InvoiceRecovery) => {
    setSupplierName(recovery.supplierName)
    setInvoiceDate(recovery.invoiceDate)
    setDueDate(recovery.dueDate)
    setInvoiceNumber(recovery.invoiceNumber)
    setPaymentMethod(recovery.paymentMethod)
    setSubtotal(recovery.subtotal)
    setTax(recovery.tax)
    setTotal(recovery.total)
    setNotes(recovery.notes)
    setLines(
      withTrailingBlank(
        recovery.lines.map((line) => ({
          ...line,
          // Drafts written before invoice pack preservation have no key.
          packSize: line.packSize ?? "",
        }))
      )
    )
  }

  const columnCount = 6

  return (
    <div className="flex flex-col gap-5">
      {conflict ? (
        <SaveBanner text={conflict.message}>
          <Button
            type="button"
            size="sm"
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              discardDraft()
              window.location.reload()
            }}
          >
            Discard my changes
          </Button>
        </SaveBanner>
      ) : null}
      {restorable ? (
        <SaveBanner text="This device kept changes that never reached the server.">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              applyRecovery(restorable as InvoiceRecovery)
              dismissRestore()
            }}
          >
            Restore
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={discardDraft}
          >
            Discard
          </Button>
        </SaveBanner>
      ) : null}
      {initial && imported ? (
        <div className="flex items-center gap-3">
          <Badge size="row">
            {initial.source === "connector"
              ? "Supplier import"
              : initial.driveFileId
                ? "From Drive"
                : "Uploaded"}
          </Badge>
          {initial.driveWebViewLink ? (
            <a
              href={initial.driveWebViewLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              Open in Drive
              <ExternalLink
                className="size-3"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <SupplierCombobox
          className="sm:col-span-2"
          value={supplierName}
          options={supplierNames}
          onChange={setSupplierName}
        />
        <DateField
          id="invoice-date"
          value={invoiceDate}
          onChange={setInvoiceDate}
          timeZone={settings.timezone}
        />
        <LabeledInput
          label="Number"
          id="invoice-number"
          value={invoiceNumber}
          onChange={(event) => setInvoiceNumber(event.target.value)}
        />
        <DateField
          label="Due date"
          id="invoice-due-date"
          value={dueDate}
          placeholder="Missing"
          timeZone={settings.timezone}
          onChange={setDueDate}
        />
        <LabeledShell label="Payment method">
          <Select
            items={paymentLabels}
            value={paymentMethod}
            onValueChange={(next) =>
              setPaymentMethod(String(next) as InvoicePaymentMethod)
            }
          >
            <SelectTrigger
              aria-label="Payment method"
              className={cn(labeledControlClassName, "justify-between")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {paymentOptions.map((method) => (
                <SelectItem key={method.value} value={method.value}>
                  {method.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </LabeledShell>
        {/* The three printed figures. Empty means the document did not print
            one, which is why the placeholder says so rather than "0.00". */}
        <LabeledInput
          label={`Subtotal (${currencyCode})`}
          id="invoice-subtotal"
          inputMode="decimal"
          placeholder="Missing"
          value={subtotal}
          onChange={(event) => setSubtotal(event.target.value)}
          className="tabular"
        />
        <LabeledInput
          label={`Tax (${currencyCode})`}
          id="invoice-tax"
          inputMode="decimal"
          placeholder="Missing"
          value={tax}
          onChange={(event) => setTax(event.target.value)}
          className="tabular"
        />
        <LabeledInput
          label={`Total (${currencyCode})`}
          id="invoice-total"
          inputMode="decimal"
          value={total}
          onChange={(event) => setTotal(event.target.value)}
          className="tabular"
        />
      </div>

      <Textarea
        aria-label="Memo"
        placeholder="Memo"
        maxLength={2000}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />

      <div>
        <TableFrame className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableHeaderRow>
                <TableHead className="pl-3">Description</TableHead>
                <TableHead className="w-[92px] text-right">Qty</TableHead>
                <TableHead className="w-[120px] text-right">
                  Unit price
                </TableHead>
                <TableHead className="w-[120px] text-right">Amount</TableHead>
                <TableHead className="w-[220px]">
                  Category or ingredient
                </TableHead>
                <TableHead className="w-11" />
              </TableHeaderRow>
            </TableHeader>
            <TableBody>
              {lines.length === 0 ? (
                <TableRow className="h-11 hover:!bg-transparent">
                  <TableCell
                    colSpan={columnCount}
                    className="pl-3 text-base text-muted-foreground"
                  >
                    No lines yet.
                  </TableCell>
                </TableRow>
              ) : (
                lines.map((line, index) => {
                  // The last row is the one waiting to be typed into.
                  const trailing =
                    index === lines.length - 1 && isBlankLine(line)
                  const reviewing = review?.key === line.key
                  // The review block carries its own copy of these, so the row
                  // never shows two of the same field.
                  const showCost =
                    !reviewing &&
                    categoryIsIngredient(categories, line.categoryId)
                  return (
                    <React.Fragment key={line.key}>
                      <TableRow
                        className={cn(
                          "h-11 hover:!bg-transparent",
                          (showCost || reviewing) && "border-b-0"
                        )}
                      >
                        <TableCell className="pl-3">
                          <Input
                            ref={trailing ? blankDescriptionRef : undefined}
                            className={cellInput}
                            value={line.description}
                            placeholder={
                              trailing ? "Add a line…" : "Description"
                            }
                            aria-label="Description"
                            onChange={(event) =>
                              patchLine(line.key, {
                                description: event.target.value,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            className={cn(cellInput, "tabular text-right")}
                            inputMode="decimal"
                            value={line.quantity}
                            placeholder="0"
                            aria-label="Quantity"
                            onChange={(event) =>
                              patchLine(line.key, {
                                quantity: event.target.value,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            className={cn(cellInput, "tabular text-right")}
                            inputMode="decimal"
                            value={line.unitPrice}
                            placeholder="0.00"
                            aria-label="Unit price"
                            onChange={(event) =>
                              patchLine(line.key, {
                                unitPrice: event.target.value,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            className={cn(cellInput, "tabular text-right")}
                            inputMode="decimal"
                            value={line.amount}
                            placeholder="0.00"
                            aria-label="Amount"
                            onChange={(event) =>
                              patchLine(line.key, {
                                amount: event.target.value,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            <Select
                              items={categoryLabels}
                              value={line.categoryId}
                              onValueChange={(next) =>
                                patchLine(line.key, {
                                  categoryId: String(next),
                                })
                              }
                            >
                              <SelectTrigger
                                size="sm"
                                aria-label="Category or ingredient"
                                className="w-full"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {categoryOptions.map((option) => (
                                  <SelectItem
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {line.needsReview ? (
                              <>
                                <TriangleAlert
                                  className="size-[13px] shrink-0 text-warning"
                                  strokeWidth={1.9}
                                  aria-hidden="true"
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={dirty}
                                  title={
                                    dirty
                                      ? "Save this invoice first."
                                      : undefined
                                  }
                                  onClick={() =>
                                    setReview(
                                      reviewing
                                        ? null
                                        : {
                                            key: line.key,
                                            categoryId: line.categoryId,
                                            cost: line.cost,
                                          }
                                    )
                                  }
                                >
                                  Review
                                </Button>
                              </>
                            ) : null}
                          </span>
                        </TableCell>
                        <TableCell>
                          {/* The trailing row has nothing to remove yet. */}
                          <span className="flex justify-end">
                            {trailing ? null : (
                              <RowActionsMenu
                                label={`Actions for ${
                                  line.description || "this line"
                                }`}
                              >
                                <MenuItem
                                  className="text-destructive data-highlighted:text-destructive"
                                  onClick={() =>
                                    setLines((current) =>
                                      withTrailingBlank(
                                        current.filter(
                                          (row) => row.key !== line.key
                                        )
                                      )
                                    )
                                  }
                                >
                                  <Trash2
                                    className="text-current"
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                  />
                                  Remove
                                </MenuItem>
                              </RowActionsMenu>
                            )}
                          </span>
                        </TableCell>
                      </TableRow>
                      {showCost ? (
                        <TableRow className="hover:!bg-transparent">
                          <TableCell
                            colSpan={columnCount}
                            className="px-3 py-3"
                          >
                            <LineCostFields
                              idPrefix={line.key}
                              value={line.cost}
                              onChange={(patch) =>
                                patchLine(line.key, {
                                  cost: { ...line.cost, ...patch },
                                })
                              }
                              ingredients={ingredients}
                              currencyCode={currencyCode}
                              fallbackName={line.description}
                            />
                          </TableCell>
                        </TableRow>
                      ) : null}
                      {reviewing ? (
                        <TableRow className="hover:!bg-transparent">
                          <TableCell
                            colSpan={columnCount}
                            className="bg-fill-soft px-3 py-3"
                          >
                            <LabeledShell label="Expense category">
                              <Select
                                items={categoryLabels}
                                value={review?.categoryId ?? ""}
                                onValueChange={(next) =>
                                  setReview((current) =>
                                    current
                                      ? {
                                          ...current,
                                          categoryId: String(next),
                                        }
                                      : current
                                  )
                                }
                              >
                                <SelectTrigger
                                  aria-label="Expense category"
                                  className={cn(
                                    labeledControlClassName,
                                    "justify-between"
                                  )}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {categoryOptions.map((option) => (
                                    <SelectItem
                                      key={option.value}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </LabeledShell>
                            {review &&
                            categoryIsIngredient(
                              categories,
                              review.categoryId
                            ) ? (
                              <LineCostFields
                                className="mt-3"
                                idPrefix={`review-${line.key}`}
                                value={review.cost}
                                onChange={(patch) =>
                                  setReview((current) =>
                                    current
                                      ? {
                                          ...current,
                                          cost: { ...current.cost, ...patch },
                                        }
                                      : current
                                  )
                                }
                                ingredients={ingredients}
                                currencyCode={currencyCode}
                                fallbackName={line.description}
                              />
                            ) : null}
                            <div className="mt-3 flex gap-2">
                              <Button
                                type="button"
                                pending={reviewSaving}
                                onClick={() => void saveReview(line)}
                              >
                                Save line
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => setReview(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </React.Fragment>
                  )
                })
              )}
            </TableBody>
          </Table>
        </TableFrame>

        <AddButton
          label="Add"
          className="mt-2"
          // Each click lays down another empty row above the composer, so
          // five clicks make five lines to fill in.
          onClick={() =>
            setLines((current) => {
              const next = [...current]
              const last = next[next.length - 1]
              const at =
                last && isBlankLine(last) ? next.length - 1 : next.length
              next.splice(at, 0, emptyLine())
              return next
            })
          }
        />
      </div>

      <div className="flex justify-end">
        <div className="w-full max-w-[280px]">
          <TotalLine
            label="Lines add up to"
            value={formatCents(lineSumCents, currencyCode)}
          />
          <TotalLine label="Tax" value={formatCents(taxCents, currencyCode)} />
          <TotalLine
            label="Total"
            value={formatCents(totalCents, currencyCode)}
            strong
          />
          {mismatch ? (
            <p
              role="status"
              className="mt-1 text-xs leading-[1.55] text-muted-foreground"
            >
              {`Lines add up to ${formatCents(
                lineSumCents + taxCents,
                currencyCode
              )}; the total says ${formatCents(totalCents, currencyCode)}.`}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
