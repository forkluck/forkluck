"use client"

import * as React from "react"

import type { IngredientOption } from "@/components/ingredients/types"
import {
  LineCostFields,
  SELECT_CLASS,
} from "@/components/invoices/line-cost-fields"
import {
  DOCUMENT_LABELS,
  LINE_GRID,
  LINE_LABEL,
  Notice,
  lineBadge,
  lineIsExpense,
  lineNeedsReview,
  type InvoiceState,
  type LineState,
} from "@/components/invoices/receipt-state"
import { SupplierCombobox } from "@/components/invoices/supplier-combobox"
import { ReceiptFeedback } from "@/components/invoices/receipt-feedback"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DateField } from "@/components/ui/date-field"
import { Input } from "@/components/ui/input"
import { LabeledInput } from "@/components/ui/labeled-field"
import { parseMoneyToCents } from "@/lib/invoice-import"
import {
  categoryAfterItemPick,
  lineQuantityIsValid,
  modeAfterExpenseCategorySelection,
} from "@/lib/invoice-review"
import { dollarsToCents, formatCents } from "@/lib/money"
import { cn } from "@/lib/utils"

/**
 * The right half of the reviewer: what was read off this receipt, editable.
 * The document itself is the left half, and the pager owns the decisions.
 */
export function ReceiptReview({
  invoice,
  ingredients,
  onIngredientCreated,
  supplierNames,
  onChange,
  onChangeLine,
  selectedKey,
  onSelectLine,
}: {
  invoice: InvoiceState
  ingredients: IngredientOption[]
  onIngredientCreated?: (ingredient: IngredientOption) => void
  /** Names the workspace already buys under, offered before free text. */
  supplierNames: string[]
  onChange: (key: string, patch: Partial<InvoiceState>) => void
  onChangeLine: (
    key: string,
    lineKey: string,
    patch: Partial<LineState>
  ) => void
  /** The line the document pane is drawing a box around, or none. */
  selectedKey: string | null
  onSelectLine: (lineKey: string) => void
}) {
  const { currencyCode, timezone } = useBusinessSettings()
  const categories = invoice.result.categories
  const reviewCount = invoice.lines.filter((line) =>
    lineNeedsReview(line, categories)
  ).length

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-auto">
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="row">{DOCUMENT_LABELS[invoice.result.documentType]}</Badge>
        {invoice.result.duplicate ? (
          <Badge variant="warning" size="row">
            Already imported
          </Badge>
        ) : null}
        {reviewCount > 0 ? (
          <Badge variant="warning" size="row">
            {reviewCount} to review
          </Badge>
        ) : null}
        <ReceiptFeedback
          key={invoice.key}
          invoice={invoice}
          ingredients={ingredients}
          onSaved={(feedback) => onChange(invoice.key, { feedback })}
        />
      </div>

      {invoice.result.totalsMismatch ? (
        <Notice>{invoice.result.totalsMismatch}</Notice>
      ) : null}
      {invoice.result.headerWarnings.map((warning) => (
        <Notice key={warning}>{warning}</Notice>
      ))}

      <div className="grid gap-3 sm:grid-cols-4">
        <SupplierCombobox
          className="sm:col-span-2"
          value={invoice.supplierName}
          options={supplierNames}
          onChange={(next) => onChange(invoice.key, { supplierName: next })}
        />
        <LabeledInput
          label="Number"
          id={`${invoice.key}-number`}
          value={invoice.invoiceNumber}
          onChange={(event) =>
            onChange(invoice.key, { invoiceNumber: event.target.value })
          }
        />
        <DateField
          id={`${invoice.key}-date`}
          value={invoice.invoiceDate}
          onChange={(next) => onChange(invoice.key, { invoiceDate: next })}
          timeZone={timezone}
        />
        <LabeledInput
          label={`Total (${currencyCode})`}
          id={`${invoice.key}-total`}
          inputMode="decimal"
          value={invoice.total}
          onChange={(event) =>
            onChange(invoice.key, { total: event.target.value })
          }
          className="tabular"
        />
      </div>

      <div className="rounded-xl border border-border">
        <div
          className={cn(
            LINE_GRID,
            "sticky top-0 z-10 hidden items-center border-b border-border bg-card px-3 py-2 text-2xs leading-none font-medium text-ink-soft"
          )}
        >
          <span>Line</span>
          <span>Status</span>
          <span>Category</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Amount</span>
        </div>
        {invoice.lines.map((line) => {
          const badge = lineBadge(line, categories)
          const amount = Number(line.amount)
          const price = dollarsToCents(line.price)
          const validResolution =
            Boolean(line.entry.itemKey) &&
            Number.isFinite(amount) &&
            amount > 0 &&
            price !== null &&
            price > 0
          // The probe already picked a pantry item for this line — supplier
          // history, then an exact name, then the catalog. One click takes it.
          const suggestion =
            line.mode === "review" &&
            line.ingredientId !== "" &&
            !lineIsExpense(line, categories)
              ? {
                  name:
                    ingredients.find(
                      (ingredient) => ingredient.id === line.ingredientId
                    )?.name || line.name,
                  pack: line.amount ? `${line.amount} ${line.unit}` : null,
                  price:
                    price === null ? null : formatCents(price, currencyCode),
                }
              : null
          return (
            <div
              key={line.key}
              // Selecting a row is what moves the box on the document beside
              // it, so anywhere on the row that isn't a control counts, and so
              // does reaching a control inside it with the keyboard.
              onClick={(event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest("button, select, input, label")
                ) {
                  return
                }
                onSelectLine(line.key)
              }}
              onFocusCapture={() => onSelectLine(line.key)}
              className={cn(
                "border-b border-muted transition-colors last:border-b-0",
                // The selected fill the rest of the app uses, plus a brand
                // edge so the row reads as chosen rather than merely tinted.
                selectedKey === line.key &&
                  "bg-brand-selected shadow-[inset_2px_0_0_0_var(--brand)]"
              )}
            >
              <div className={cn(LINE_GRID, "grid items-start px-3 py-2.5")}>
                <span className="min-w-0">
                  <span className="line-clamp-2 text-md break-words text-foreground">
                    {line.entry.sku ? (
                      <span className="mr-1.5 text-sm text-faint">
                        {line.entry.sku.toUpperCase()}
                      </span>
                    ) : null}
                    {line.entry.description}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-xs break-words text-faint">
                    {[
                      line.entry.packSize,
                      line.entry.match.kind === "update"
                        ? `Updates ${line.entry.match.ingredientName}`
                        : null,
                      line.entry.match.kind === "expense-only"
                        ? line.entry.match.note
                        : null,
                      lineNeedsReview(line, categories)
                        ? line.entry.match.kind === "review"
                          ? line.entry.match.reason
                          : line.entry.reason
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="flex flex-col items-start gap-1">
                  <span className={LINE_LABEL}>Status</span>
                  <Badge variant={badge.variant} size="row">
                    {badge.label}
                  </Badge>
                  {line.mode === "review" &&
                  !lineIsExpense(line, categories) ? (
                    <span className="flex gap-1">
                      {line.entry.itemKey ? (
                        <>
                          {suggestion ? null : (
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={() =>
                                onChangeLine(invoice.key, line.key, {
                                  mode: "resolving",
                                })
                              }
                            >
                              Resolve
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() =>
                              onChangeLine(invoice.key, line.key, {
                                mode: "ignored",
                              })
                            }
                          >
                            Ignore
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() =>
                            onChangeLine(invoice.key, line.key, {
                              mode: "resolved",
                            })
                          }
                        >
                          Accept expense
                        </Button>
                      )}
                    </span>
                  ) : line.mode === "resolved" || line.mode === "ignored" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        onChangeLine(invoice.key, line.key, {
                          mode:
                            line.entry.match.kind === "review"
                              ? "review"
                              : "auto",
                          propagated: false,
                        })
                      }
                    >
                      Undo
                    </Button>
                  ) : null}
                </span>
                <span className="flex flex-col gap-1">
                  <span className={LINE_LABEL}>Category</span>
                  <select
                    value={line.categoryId ?? ""}
                    onChange={(event) => {
                      const categoryId = event.target.value || null
                      onChangeLine(invoice.key, line.key, {
                        categoryId,
                        mode: modeAfterExpenseCategorySelection({
                          mode: line.mode,
                          itemKey: line.entry.itemKey,
                          categoryId,
                        }),
                      })
                    }}
                    aria-label="Expense category"
                    className={cn(SELECT_CLASS, "w-full")}
                  >
                    <option value="">No category</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </span>
                <span className="tabular flex items-center justify-between gap-3 text-base whitespace-nowrap text-muted-foreground md:justify-end">
                  <span className={LINE_LABEL}>Qty</span>
                  <span className="flex min-w-0 items-center justify-end gap-1">
                    <Input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      value={line.quantity}
                      onChange={(event) =>
                        onChangeLine(invoice.key, line.key, {
                          quantity: event.target.value,
                        })
                      }
                      placeholder="—"
                      aria-label={`Quantity for ${line.entry.description}`}
                      aria-invalid={!lineQuantityIsValid(line)}
                      className="tabular h-8 w-16 px-2 text-right text-sm md:text-sm"
                    />
                    {line.entry.unit ? <span>{line.entry.unit}</span> : null}
                  </span>
                </span>
                <span className="tabular flex items-baseline justify-between gap-3 text-base whitespace-nowrap text-muted-foreground md:block md:pt-1.5 md:text-right">
                  <span className={LINE_LABEL}>Amount</span>
                  {line.entry.lineAmountCents === null ? (
                    <Input
                      inputMode="decimal"
                      value={line.lineAmount}
                      onChange={(event) =>
                        onChangeLine(invoice.key, line.key, {
                          lineAmount: event.target.value,
                        })
                      }
                      placeholder="0.00"
                      aria-label={`Amount for ${line.entry.description}`}
                      aria-invalid={parseMoneyToCents(line.lineAmount) === null}
                      className="tabular h-8 text-right text-sm md:-mt-1.5 md:text-sm"
                    />
                  ) : (
                    formatCents(line.entry.lineAmountCents, currencyCode)
                  )}
                </span>
              </div>

              {suggestion ? (
                <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      onChangeLine(invoice.key, line.key, {
                        // An incomplete suggestion still needs a pack and a
                        // price, so it opens the drawer already filled in.
                        mode: validResolution ? "resolved" : "resolving",
                      })
                    }
                  >
                    {[
                      `Use ${suggestion.name}`,
                      suggestion.pack,
                      suggestion.price,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      onChangeLine(invoice.key, line.key, { mode: "resolving" })
                    }
                  >
                    Resolve
                  </Button>
                </div>
              ) : null}

              {line.mode === "resolving" ? (
                <div className="border-t border-muted bg-fill-soft px-3 py-3">
                  <LineCostFields
                    idPrefix={line.key}
                    onIngredientCreated={onIngredientCreated}
                    value={{
                      ingredientId: line.ingredientId,
                      name: line.name,
                      amount: line.amount,
                      unit: line.unit,
                      price: line.price,
                    }}
                    onChange={(patch) =>
                      onChangeLine(
                        invoice.key,
                        line.key,
                        patch.ingredientId === undefined
                          ? patch
                          : {
                              ...patch,
                              // Picking the item answers the category too:
                              // a supply files under Packaging, food under
                              // Ingredients, unless one is already costable.
                              categoryId: categoryAfterItemPick({
                                categoryId: line.categoryId,
                                nonEdible:
                                  ingredients.find(
                                    (ingredient) =>
                                      ingredient.id === patch.ingredientId
                                  )?.nonEdible ?? false,
                                categories,
                              }),
                            }
                      )
                    }
                    ingredients={ingredients}
                    currencyCode={currencyCode}
                    fallbackName={line.entry.description}
                  />
                  <label className="mt-3 flex items-center gap-2.5 text-xs text-foreground">
                    <Checkbox
                      checked={line.remember}
                      onCheckedChange={(checked) =>
                        onChangeLine(invoice.key, line.key, {
                          remember: !!checked,
                        })
                      }
                    />
                    Remember for {invoice.supplierName || "this supplier"}
                  </label>
                  <p className="mt-1 pl-6.5 text-xs text-muted-foreground">
                    {line.entry.description} →{" "}
                    {ingredients.find(
                      (ingredient) => ingredient.id === line.ingredientId
                    )?.name ||
                      line.name ||
                      line.entry.description}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      type="button"
                      disabled={!validResolution}
                      onClick={() =>
                        onChangeLine(invoice.key, line.key, {
                          mode: "resolved",
                        })
                      }
                    >
                      Add price update
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        onChangeLine(invoice.key, line.key, { mode: "review" })
                      }
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
