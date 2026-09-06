"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import {
  ChevronDown,
  Clock,
  Info,
  RotateCcw,
  SquarePen,
  Tag,
  Trash2,
} from "lucide-react"

import {
  resetIngredientConversion,
  saveIngredientConversion,
} from "@/app/(app)/ingredients/actions"
import {
  useIngredientEdit,
  useIngredientFormBinding,
  useIngredientTabSave,
} from "@/components/ingredients/ingredient-chrome"
import { IngredientForm } from "@/components/ingredients/ingredient-form"
import { DeleteWithUsageDialog } from "@/components/ingredients/ingredient-delete-dialog"
import { PriceHistoryDialog } from "@/components/ingredients/price-history-dialog"
import {
  EMPTY_PURCHASE_UNIT,
  PurchaseUnitFields,
  type PurchaseUnit,
} from "@/components/ingredients/purchase-unit-fields"
import { inlineChipClassName } from "@/components/ingredients/unit-combobox"
import { UnitConversionFields } from "@/components/unit-conversion-fields"
import { GuardedLink } from "@/components/navigation-blocker"
import { UsedInList, useUsedInRows } from "@/components/recipes/used-in-list"

import { BulkDeleteMenu } from "@/components/ui/bulk-delete-menu"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { useToast } from "@/components/ui/toast"
import { RowActionsMenu } from "@/components/ui/row-actions"
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
import { preparationDefaults } from "@/lib/ingredient-preparations"
import { conversionUnitOptions, unitShort } from "@/lib/unit-registry"
import { centsToDollarInput } from "@/lib/money"
import { productHref } from "@/lib/product-href"
import { formatKitchenAmount } from "@/lib/recipe"
import { AddButton } from "@/components/ui/add-button"
import type { IngredientRow, IngredientTagOptionRow } from "@/lib/backend/types"
import { useRefresh } from "@/hooks/use-refresh"

const CONVERSION_UNITS = conversionUnitOptions()

const formValues = (ingredient: IngredientRow) => ({
  id: ingredient.id,
  name: ingredient.name,
  editVersion: ingredient.editVersion,
  category: ingredient.category,
  purchaseCostCents: ingredient.purchaseCostCents,
  purchaseSize: ingredient.purchaseSize,
  purchaseUnit: ingredient.purchaseUnit,
  priceSource: ingredient.priceSource,
  tags: ingredient.tags,
})

const measure = (amount: number | string | null, unit: string | null) => {
  const value =
    typeof amount === "number" ? String(amount) : (amount ?? "").trim()
  if (value === "" || !Number.isFinite(Number.parseFloat(value))) return "–"
  const short = unit === "cup" ? "cup" : unitShort(unit)
  return short ? `${value} ${short}` : value
}

const preparationMeasure = (
  preparation: IngredientRow["preparations"][number],
  family: "weight" | "volume" | "each"
) => {
  const value = preparation[family]
  return measure(value?.amount ?? null, value?.unit ?? null)
}

const purchasedAs = (
  ingredient: IngredientRow | null,
  purchaseUnit: PurchaseUnit | null
): PurchaseUnit | null => {
  if (purchaseUnit) return purchaseUnit
  if (!ingredient) return null
  const pack = preparationDefaults(ingredient)
  return pack
    ? {
        cost: centsToDollarInput(ingredient.purchaseCostCents),
        size: pack.weight,
        unit: pack.weightUnit,
        yieldPercent: String(ingredient.yieldPercent),
      }
    : null
}

const purchaseKey = (unit: PurchaseUnit | null) =>
  `${unit?.cost ?? ""}|${unit?.size ?? ""}|${unit?.unit ?? ""}|${
    unit?.yieldPercent ?? ""
  }|${unit?.invoiceLineId ?? ""}|${unit?.disconnectInvoicePriceId ?? ""}|${
    unit?.useInvoicePriceId ?? ""
  }`

function conversionFields(conversion: IngredientRow["conversion"] | null) {
  const measure = (
    value: { amount: number; unit: string } | null | undefined
  ) => ({
    amount: value ? String(value.amount) : "",
    unit: value?.unit ?? null,
  })
  return {
    weight: measure(conversion?.weight),
    volume: measure(conversion?.volume),
    each: measure(conversion?.each),
  }
}

function UnitConversionSection({
  ingredient,
}: {
  ingredient: IngredientRow | null
}) {
  const { commit } = useIngredientEdit()
  const toast = useToast()
  const units = CONVERSION_UNITS
  const [resetPending, setResetPending] = React.useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = React.useState(false)
  const conversion = ingredient?.conversion ?? null
  // Not a setting any more — it is what the saved conversion happens to be.
  // Typing into a field saves `usesStandardConversion: false`, and Reset to
  // default puts it back, so the state follows the measurements rather than a
  // switch the cook has to understand before the fields will accept input.
  const usesStandardConversion =
    conversion === null || conversion.usesStandardConversion
  const [fields, setFields] = React.useState(() => conversionFields(conversion))
  // The draft follows the saved conversion, but adjusting it in an effect
  // costs a second render pass and — worse — lands after the user has already
  // started typing into the re-rendered field. React's documented alternative
  // is to compare against the previous value during render and reset there.
  const [lastConversion, setLastConversion] = React.useState(conversion)
  // What the last issued write is sending — a ref, so a second commit issued
  // while the first is in flight snapshots that and not the older state.
  const confirmed = React.useRef({ conversion, fields })
  if (conversion !== lastConversion) {
    setLastConversion(conversion)
    setFields(conversionFields(conversion))
  }
  // A newly delivered conversion supersedes what the ref remembers.
  const baseline = () =>
    confirmed.current.conversion === conversion
      ? confirmed.current.fields
      : conversionFields(conversion)
  const remember = (next: typeof fields) => {
    confirmed.current = { conversion, fields: next }
  }

  const measureFromField = (field: { amount: string; unit: string | null }) => {
    const amount = Number.parseFloat(field.amount)
    return field.unit && Number.isFinite(amount) && amount >= 0
      ? { amount, unit: field.unit }
      : null
  }

  const persistFields = (next: typeof fields) => {
    if (!ingredient) return
    const previous = baseline()
    remember(next)
    void commit({
      domain: `ingredient:${ingredient.id}:conversion`,
      apply: () => setFields(next),
      revert: () => {
        setFields(previous)
        remember(previous)
      },
      write: () =>
        saveIngredientConversion({
          ingredientId: ingredient.id,
          usesStandardConversion: false,
          weight: measureFromField(next.weight),
          volume: measureFromField(next.volume),
          each: measureFromField(next.each),
        }),
    }).then((failure) => {
      if (failure) toast.add({ title: failure.message, type: "error" })
    })
  }

  return (
    <section className="mt-6 max-w-[640px]">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-lg font-semibold">UOM</h2>
          <Tooltip>
            <TooltipTrigger
              render={
                <Info
                  className="size-[14px] shrink-0 text-muted-foreground"
                  strokeWidth={1.8}
                  role="img"
                  aria-label="What the standard UOM means"
                />
              }
            />
            <TooltipContent className="max-w-[280px]">
              {usesStandardConversion ? (
                <>
                  A known ingredient density is used when available. Otherwise,
                  the standard estimate is 227 g per cup. Type over any field to
                  use your own measurement instead.
                </>
              ) : (
                <>
                  These are your own measurements. Leave any that don’t apply
                  blank, or reset the row to go back to the standard ones.
                </>
              )}
            </TooltipContent>
          </Tooltip>
          {conversion?.source === "catalog" ? (
            <span className="text-2xs text-muted-foreground">Estimate</span>
          ) : null}
        </div>
      </div>
      <div className="mt-3">
        <UnitConversionFields
          idPrefix="conversion"
          values={fields}
          options={units}
          disabled={!ingredient}
          onChange={setFields}
          onCommit={(next) => void persistFields(next)}
          actions={
            <RowActionsMenu
              label="UOM actions"
              className="w-48"
              disabled={!ingredient || usesStandardConversion}
            >
              <MenuItem
                disabled={resetPending}
                onClick={() => setResetConfirmOpen(true)}
              >
                <RotateCcw strokeWidth={1.8} aria-hidden="true" />
                Reset to default
              </MenuItem>
            </RowActionsMenu>
          }
        />
      </div>
      <ConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title="Reset UOM?"
        description="This replaces your measurements with the ingredient’s default conversion. This can’t be undone."
        confirmLabel="Reset to default"
        pending={resetPending}
        onConfirm={async () => {
          if (!ingredient) return
          const previous = baseline()
          remember(conversionFields(null))
          setResetPending(true)
          const failure = await commit({
            domain: `ingredient:${ingredient.id}:conversion`,
            apply: () => setFields(conversionFields(null)),
            revert: () => {
              setFields(previous)
              remember(previous)
            },
            write: () => resetIngredientConversion(ingredient.id),
          })
          setResetPending(false)
          if (failure) toast.add({ title: failure.message, type: "error" })
          else setResetConfirmOpen(false)
        }}
      />
    </section>
  )
}

function PreparationsDivider() {
  return (
    <hr className="mt-8 h-1.5 w-full max-w-[640px] rounded-sm border-0 bg-secondary" />
  )
}

export function IngredientCostPanel({
  ingredient,
  embedded = false,
}: {
  ingredient: IngredientRow
  /** Folded into a supply's one page, where the form beside it owns the
   *  header's Save; a complete pack still writes itself on blur. */
  embedded?: boolean
}) {
  const { purchaseUnit, savePurchaseUnit, saveRef, setDirty } =
    useIngredientEdit()
  useIngredientTabSave(!embedded)
  const toast = useToast()
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const purchased = purchasedAs(ingredient, purchaseUnit)
  const [fields, setFields] = React.useState<PurchaseUnit>(
    () => purchased ?? EMPTY_PURCHASE_UNIT
  )
  // `purchasedAs` builds a fresh object every render, so the saved values are
  // compared as a string rather than by identity. Resetting here rather than
  // in an effect matters for more than the render count: saving the cost round
  // trips to the server, and an effect firing on the way back would overwrite
  // whatever the cook has typed into the size field since.
  const purchasedKey = purchaseKey(purchased ?? EMPTY_PURCHASE_UNIT)
  const [lastPurchasedKey, setLastPurchasedKey] = React.useState(purchasedKey)
  const [confirmedKey, setConfirmedKey] = React.useState(purchasedKey)
  if (purchasedKey !== lastPurchasedKey) {
    setLastPurchasedKey(purchasedKey)
    setConfirmedKey(purchasedKey)
    setFields(purchased ?? EMPTY_PURCHASE_UNIT)
  }
  const fieldsKey = purchaseKey(fields)
  React.useEffect(() => {
    if (embedded) return
    setDirty(fieldsKey !== confirmedKey)
  }, [confirmedKey, embedded, fieldsKey, setDirty])

  const pending = React.useRef<{
    key: string
    promise: Promise<void>
  } | null>(null)

  const saveFields = React.useCallback(
    async (next: PurchaseUnit) => {
      setFields(next)
      const key = purchaseKey(next)
      if (pending.current?.key === key) return pending.current.promise
      const promise = Promise.resolve(savePurchaseUnit(next)).then(
        (failure) => {
          if (failure) toast.add({ title: failure.message, type: "error" })
          else {
            const settled = {
              ...next,
              invoiceLineId: null,
              invoicePurchaseSize: "",
              invoicePurchaseUnit: "",
              disconnectInvoicePriceId: null,
              useInvoicePriceId: null,
            }
            setFields(settled)
            setConfirmedKey(purchaseKey(settled))
          }
        }
      )
      pending.current = { key, promise }
      await promise
      if (pending.current?.promise === promise) pending.current = null
    },
    [savePurchaseUnit, toast]
  )

  const saveIfComplete = React.useCallback(
    (next: PurchaseUnit) => {
      const cost = Number.parseFloat(next.cost)
      const priced = Boolean(next.unit) && Number.isFinite(cost) && cost >= 0
      if (
        !next.invoiceLineId &&
        !next.disconnectInvoicePriceId &&
        !next.useInvoicePriceId &&
        !priced
      )
        return Promise.resolve()
      return saveFields(next)
    },
    [saveFields]
  )

  React.useEffect(() => {
    if (embedded) return
    // Blur waits for a complete cost/unit pair. An explicit Save must still
    // ask the purchase writer to validate an incomplete draft, so the cook is
    // told what is missing instead of watching the button do nothing.
    saveRef.current = () =>
      fieldsKey === confirmedKey ? Promise.resolve() : saveFields(fields)
    return () => {
      saveRef.current = null
    }
  }, [confirmedKey, embedded, fields, fieldsKey, saveFields, saveRef])

  return (
    <section className={embedded ? "mt-6 max-w-[640px]" : "max-w-[640px]"}>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Cost</h2>
        <div className="relative">
          <Menu>
            <MenuTrigger
              render={<button type="button" className={inlineChipClassName} />}
            >
              <span className="underline decoration-1 underline-offset-2">
                Actions
              </span>
              <ChevronDown
                className="size-3.5 text-foreground"
                strokeWidth={2}
                aria-hidden="true"
              />
            </MenuTrigger>
            <MenuContent align="end" className="w-48">
              <MenuItem onClick={() => setHistoryOpen(true)}>
                <Clock strokeWidth={1.8} aria-hidden="true" />
                Price history
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>

      <div className="mt-3">
        <PurchaseUnitFields
          value={fields}
          onChange={setFields}
          onCommit={(next) => void saveIfComplete(next)}
          invoicePrices={ingredient.invoicePrices ?? []}
          allowItemSync
        />
      </div>

      <PriceHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        history={ingredient.priceHistory}
      />
    </section>
  )
}

type UsedInRecipe = IngredientRow["usedInRecipes"][number]

function UsedInSection({
  usedInRecipes,
}: {
  usedInRecipes: readonly UsedInRecipe[]
}) {
  const rows = useUsedInRows(usedInRecipes)

  return (
    <section className="mt-6 max-w-[640px]">
      <div className="flex min-h-8 items-center gap-1.5">
        <h2 className="text-lg font-semibold">Used in</h2>
        {rows.length > 0 ? (
          <span className="text-sm text-muted-foreground tabular-nums">
            {rows.length}
          </span>
        ) : null}
      </div>
      <UsedInList rows={rows} />
    </section>
  )
}

type UsedInProduct = IngredientRow["usedInProducts"][number]

/**
 * Every product that sells this supply. A recipe can never hold a supply, so
 * on a supply's page this list stands where the recipe one does. Inactive
 * products sink to the bottom the way archived recipes do: they still count,
 * they just are not on the menu.
 */
function UsedInProductsSection({
  usedInProducts,
}: {
  usedInProducts: readonly UsedInProduct[]
}) {
  const rows = React.useMemo(
    () =>
      [...usedInProducts].sort(
        (left, right) => Number(!left.isActive) - Number(!right.isActive)
      ),
    [usedInProducts]
  )

  return (
    <section className="mt-6 max-w-[640px]">
      <div className="flex min-h-8 items-center gap-1.5">
        <h2 className="text-lg font-semibold">Used in</h2>
        {rows.length > 0 ? (
          <span className="text-sm text-muted-foreground tabular-nums">
            {rows.length}
          </span>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-base text-muted-foreground">
          No product uses this yet.
        </p>
      ) : (
        <div className="mt-3 divide-y divide-muted border-y border-muted">
          {rows.map((product) => (
            <GuardedLink
              key={product.id}
              href={productHref(product)}
              className="flex min-h-9 items-center gap-2.5 px-1 text-base font-medium text-foreground outline-none hover:bg-fill-soft focus-visible:underline"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                <Tag
                  className="size-3.5"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </span>
              <span className="min-w-0 flex-1 truncate">{product.name}</span>
              {product.isActive ? null : (
                <span className="shrink-0 text-2xs text-muted-foreground">
                  Inactive
                </span>
              )}
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {product.quantity === null
                  ? ""
                  : `${formatKitchenAmount(product.quantity)} ${product.unit}`.trim()}
              </span>
            </GuardedLink>
          ))}
        </div>
      )}
    </section>
  )
}

export function IngredientPanel({
  ingredient,
  availableTags,
  categoryOptions = [],
}: {
  ingredient: IngredientRow
  availableTags: IngredientTagOptionRow[]
  categoryOptions?: readonly string[]
}) {
  const { refresh } = useRefresh()
  const binding = useIngredientFormBinding()
  const { addPreparation, editPreparation, removePreparations } =
    useIngredientEdit()
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  // The row waiting on its own confirmation, so the recipes standing in the
  // way have somewhere to be listed.
  const [deleting, setDeleting] = React.useState<{
    id: string
    name: string
  } | null>(null)
  const toast = useToast()
  const preparations = ingredient.preparations

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })

  const selectedCount = preparations.filter((one) =>
    selected.has(one.id)
  ).length

  return (
    <IngredientForm
      {...binding}
      section="ingredient"
      profileLayout
      availableTags={availableTags}
      categoryOptions={categoryOptions}
      initial={formValues(ingredient)}
      onDone={() => void refresh()}
    >
      {/* A supply is bought and used in one unit: nothing to prepare, and
          no measures to convert between. Its cost sits on this one page
          instead of a tab of its own. */}
      {ingredient.nonEdible ? (
        <>
          <PreparationsDivider />
          <IngredientCostPanel ingredient={ingredient} embedded />
        </>
      ) : (
        <>
          <section className="max-w-[640px]">
            <h2 className="mb-2 text-base font-medium">Preparations</h2>
            {/* Over the frame, not inside it: the bar must not pan with the
            columns; it covers the header row the way every table shows a
            selection. */}
            <div className="relative">
              {selectedCount > 0 ? (
                <div className="absolute inset-x-0.5 top-0 z-10 flex h-[49px] items-center gap-2.5 border-b border-border bg-card pl-3.5">
                  <Checkbox
                    checked={selectedCount === preparations.length}
                    indeterminate={selectedCount < preparations.length}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked
                          ? new Set(preparations.map((one) => one.id))
                          : new Set()
                      )
                    }
                    aria-label="Select all preparations"
                  />
                  <span className="text-sm font-medium tabular-nums">
                    {selectedCount} selected
                  </span>
                  <BulkDeleteMenu
                    count={selectedCount}
                    noun="preparation"
                    description="They are removed from this ingredient. Recipes using them keep their own lines."
                    refreshAfterDelete={false}
                    onDelete={async () => {
                      const result = await removePreparations([...selected])
                      if ("error" in result) {
                        toast.add({ title: result.error, type: "error" })
                        return false
                      }
                      setSelected(new Set())
                    }}
                  />
                </div>
              ) : null}
              <TableFrame className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableHeaderRow>
                      <TableHead className="w-10 max-w-10 min-w-10 pr-0 pl-3.5">
                        {preparations.length > 0 ? (
                          <Checkbox
                            checked={selectedCount === preparations.length}
                            indeterminate={
                              selectedCount > 0 &&
                              selectedCount < preparations.length
                            }
                            onCheckedChange={(checked) =>
                              setSelected(
                                checked
                                  ? new Set(preparations.map((one) => one.id))
                                  : new Set()
                              )
                            }
                            aria-label="Select all preparations"
                          />
                        ) : null}
                      </TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="w-20">Yield</TableHead>
                      <TableHead className="w-24">Weight</TableHead>
                      <TableHead className="w-24">Volume</TableHead>
                      <TableHead className="w-24">Each</TableHead>
                      <TableHead className="w-11" />
                    </TableHeaderRow>
                  </TableHeader>
                  <TableBody>
                    {preparations.length === 0 ? (
                      <TableEmpty colSpan={7}>No preparations yet.</TableEmpty>
                    ) : (
                      preparations.map((preparation) => (
                        <TableRow
                          key={preparation.id}
                          className="hover:!bg-transparent"
                        >
                          <TableCell className="w-10 max-w-10 min-w-10 pr-0 pl-3.5">
                            <Checkbox
                              checked={selected.has(preparation.id)}
                              onCheckedChange={(checked) =>
                                toggle(preparation.id, checked === true)
                              }
                              aria-label={`Select ${preparation.name}`}
                            />
                          </TableCell>
                          <TableCell>
                            <button
                              type="button"
                              onClick={() =>
                                editPreparation({
                                  id: preparation.id,
                                  name: preparation.name,
                                  yieldPercent: preparation.yieldPercent,
                                  usesStandardConversion:
                                    preparation.usesStandardConversion,
                                  weight: preparation.weight,
                                  volume: preparation.volume,
                                  each: preparation.each,
                                })
                              }
                              className="font-medium text-foreground underline decoration-1 underline-offset-4 outline-none hover:opacity-75 focus-visible:opacity-75"
                            >
                              {preparation.name}
                            </button>
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {preparation.yieldPercent === null
                              ? "–"
                              : `${preparation.yieldPercent}%`}
                            {preparation.source === "catalog" ? (
                              <span className="ml-1 text-2xs text-muted-foreground">
                                Estimate
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {preparationMeasure(preparation, "weight")}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {preparationMeasure(preparation, "volume")}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {preparationMeasure(preparation, "each")}
                          </TableCell>
                          <TableCell>
                            <RowActionsMenu
                              label={`Actions for ${preparation.name}`}
                            >
                              <MenuItem
                                onClick={() =>
                                  editPreparation({
                                    id: preparation.id,
                                    name: preparation.name,
                                    yieldPercent: preparation.yieldPercent,
                                    usesStandardConversion:
                                      preparation.usesStandardConversion,
                                    weight: preparation.weight,
                                    volume: preparation.volume,
                                    each: preparation.each,
                                  })
                                }
                              >
                                <SquarePen
                                  strokeWidth={1.8}
                                  aria-hidden="true"
                                />
                                Edit
                              </MenuItem>
                              <MenuItem
                                onClick={() =>
                                  setDeleting({
                                    id: preparation.id,
                                    name: preparation.name,
                                  })
                                }
                                className="text-destructive data-highlighted:text-destructive"
                              >
                                <Trash2
                                  className="text-current"
                                  strokeWidth={1.8}
                                  aria-hidden="true"
                                />
                                Delete
                              </MenuItem>
                            </RowActionsMenu>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableFrame>
            </div>
            <AddButton className="mt-3" onClick={addPreparation} />
          </section>
          <PreparationsDivider />
          <UnitConversionSection ingredient={ingredient} />
          <PreparationsDivider />
        </>
      )}
      {ingredient.nonEdible ? (
        <UsedInProductsSection usedInProducts={ingredient.usedInProducts} />
      ) : (
        <UsedInSection usedInRecipes={ingredient.usedInRecipes} />
      )}
      {deleting ? (
        <DeleteWithUsageDialog
          title="Delete preparation?"
          description="Recipes asking this ingredient for in this state lose the yield and conversions it carried."
          name={deleting.name}
          confirmLabel="Delete preparation"
          blockedMessage="This preparation can’t be deleted because it is used in the following recipes:"
          open
          onOpenChange={(next) => {
            if (!next) setDeleting(null)
          }}
          onDelete={() => removePreparations([deleting.id])}
          onDeleted={() => setDeleting(null)}
        />
      ) : null}
    </IngredientForm>
  )
}

/** The pack a supply is bought in, typed before it exists: nothing to write
 *  it to yet, so the form's own save carries it with the rest. */
function NewSupplyCostSection() {
  const { purchaseUnit, savePurchaseUnit } = useIngredientEdit()
  const [fields, setFields] = React.useState<PurchaseUnit>(
    purchaseUnit ?? EMPTY_PURCHASE_UNIT
  )

  return (
    <section className="mt-6 max-w-[640px]">
      <div className="flex min-h-8 items-center">
        <h2 className="text-lg font-semibold">Cost</h2>
      </div>
      <div className="mt-3">
        <PurchaseUnitFields
          value={fields}
          onChange={setFields}
          onCommit={(next) => void savePurchaseUnit(next)}
          invoicePrices={[]}
          allowItemSync={false}
        />
      </div>
    </section>
  )
}

export function NewIngredientPanel({
  availableTags,
  categoryOptions = [],
  nonEdible = false,
}: {
  availableTags: IngredientTagOptionRow[]
  categoryOptions?: readonly string[]
  /** Creates a supply; it lands on the same ingredient screen. */
  nonEdible?: boolean
}) {
  const router = useRouter()
  const binding = useIngredientFormBinding()

  return (
    <IngredientForm
      {...binding}
      section="all"
      nonEdible={nonEdible}
      profileLayout
      availableTags={availableTags}
      categoryOptions={categoryOptions}
      initial={null}
      onSaved={(_id, values) =>
        router.push(`/ingredients/${values.publicId}/ingredient`)
      }
      onDone={() => undefined}
    >
      {nonEdible ? (
        <>
          <PreparationsDivider />
          <NewSupplyCostSection />
        </>
      ) : (
        <>
          <section className="max-w-[640px]">
            <h2 className="mb-2 text-base font-medium">Preparations</h2>
            <TableFrame className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableHeaderRow>
                    <TableHead className="w-10 pl-3.5" />
                    <TableHead>Name</TableHead>
                    <TableHead className="w-20">Yield</TableHead>
                    <TableHead className="w-24">Weight</TableHead>
                    <TableHead className="w-24">Volume</TableHead>
                    <TableHead className="w-24">Each</TableHead>
                    <TableHead className="w-11" />
                  </TableHeaderRow>
                </TableHeader>
                <TableBody>
                  <TableEmpty colSpan={7}>
                    Save this ingredient to add preparations.
                  </TableEmpty>
                </TableBody>
              </Table>
            </TableFrame>
            <AddButton className="mt-3" onClick={() => undefined} disabled />
          </section>
          <PreparationsDivider />
          <UnitConversionSection ingredient={null} />
        </>
      )}
    </IngredientForm>
  )
}
