"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { TriangleAlert, Unlink, X } from "lucide-react"
import { useRouter } from "next/navigation"

import {
  saveSalesProduct,
  untrackSalesVariant,
} from "@/app/(app)/products/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import {
  componentDrafts,
  componentsPatch,
  validateComponents,
  ProductComponentsCard,
  type ProductComponentDraft,
} from "@/components/menu/product-components"
import { ProductCategoryCombobox } from "@/components/menu/product-category-combobox"
import { ChannelIcon } from "@/components/menu/product-cells"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { ProductSalesSection } from "@/components/menu/product-sales"
import { AddButton } from "@/components/ui/add-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  displayUnitShort,
  inlineChipClassName,
  UnitCombobox,
} from "@/components/ingredients/unit-combobox"
import {
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
} from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SaveButton } from "@/components/ui/save-button"
import { SaveStatus } from "@/components/ui/save-status"
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
import { useEditChrome } from "@/hooks/use-edit-chrome"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { useRefresh } from "@/hooks/use-refresh"
import { costIssueLine } from "@/lib/menu/cost-issues"
import {
  isProductUnit,
  productUnitOptions,
  type ProductUnitSlug,
} from "@/lib/unit-registry"
import { formatMultiplier, parseMultiplier } from "@/lib/sales-identity"
import { toSaveFailure } from "@/lib/save-failure"
import { dollarsToCents } from "@/lib/money"
import { productHref } from "@/lib/product-href"
import { cn } from "@/lib/utils"
import type {
  MenuIngredientOption,
  MenuProductOption,
  MenuRecipeOption,
  ProductDetail,
} from "@/lib/backend/types"

type ProductVariant = ProductDetail["variants"][number]

/** One SKU the product sells under, and how many units one sale is. */
type SkuDraft = { key: string; sku: string; quantityMultiplier: number }

type ProductDraft = {
  name: string
  skus: SkuDraft[]
  description: string
  category: string
  sellPriceCents: number
  /** Blank is "each", the unit every product carried before this field. */
  baseUnit: "" | ProductUnitSlug
  isActive: boolean
}

const NAME_FIELD = "product-name"
const PRICE_FIELD = "product-price"
const SKU_FIELD = "product-sku"

let skuKeySeed = 0
const newSku = (): SkuDraft => ({
  key: `new-${skuKeySeed++}`,
  sku: "",
  quantityMultiplier: 1,
})

const UNIT_OPTIONS = productUnitOptions()

function draftFrom(product: ProductDetail | null): ProductDraft {
  // A product that does not exist yet: named by the merchant, sold by each,
  // priced at nothing and on sale from the moment it is saved.
  if (!product)
    return {
      name: "",
      skus: [],
      description: "",
      category: "",
      sellPriceCents: 0,
      baseUnit: "",
      isActive: true,
    }
  return {
    name: product.name,
    skus: product.skus.map((row) => ({
      key: row.id,
      sku: row.sku,
      quantityMultiplier: row.quantityMultiplier,
    })),
    description: product.description,
    category: product.category,
    sellPriceCents: product.sellPriceCents,
    baseUnit: isProductUnit(product.baseUnit) ? product.baseUnit : "",
    isActive: product.isActive,
  }
}

function variantLabel(variant: ProductVariant) {
  const name =
    variant.externalName.trim() || variant.sku.trim() || "Unnamed variant"
  const variantTitle = variant.externalVariantTitle.trim()
  return variantTitle ? `${name} · ${variantTitle}` : name
}

function channelLabel(channel: string) {
  if (channel === "square") return "Square"
  if (channel === "shopify") return "Shopify"
  return channel || "Sales channel"
}

function variantGroups(product: ProductDetail) {
  const groups = new Map<string, ProductVariant[]>()
  for (const variant of product.variants) {
    const group = groups.get(variant.channel) ?? []
    group.push(variant)
    groups.set(variant.channel, group)
  }
  return [...groups.entries()].sort(([left], [right]) =>
    channelLabel(left).localeCompare(channelLabel(right))
  )
}

/** What a save sends: an empty list clears every SKU. */
function skusPatch(skus: SkuDraft[]) {
  return skus
    .filter((row) => row.sku.trim())
    .map((row) => ({
      sku: row.sku.trim(),
      quantityMultiplier: row.quantityMultiplier,
    }))
}

function validateSkus(skus: SkuDraft[]): FormErrors {
  const seen = new Set<string>()
  for (const row of skus) {
    const sku = row.sku.trim().toUpperCase()
    const field = `${SKU_FIELD}-${row.key}`
    if (!sku) return { [field]: "Enter a SKU." }
    if (seen.has(sku)) return { [field]: "SKUs have to be different." }
    seen.add(sku)
    if (!(row.quantityMultiplier > 0))
      return { [field]: "Units per sale has to be greater than zero." }
  }
  return {}
}

/** The x-N chip on a SKU row: a popover with one number in it. */
function MultiplierChip({
  value,
  unit,
  onChange,
}: {
  value: number
  /** The product's sold-by unit: the count is in it, so the chip says so. */
  unit: string
  onChange: (value: number) => void
}) {
  const [text, setText] = React.useState(() => formatMultiplier(value))
  const parsed = parseMultiplier(text)
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) setText(formatMultiplier(value))
      }}
    >
      <Popover.Trigger
        aria-label="Units per sale"
        className={cn(inlineChipClassName, "data-popup-open:bg-fill-soft")}
      >
        <span className="underline decoration-current underline-offset-2">
          {formatMultiplier(value)} {unit}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={4} className="z-50">
          <Popover.Popup className="z-50 w-[180px] origin-(--transform-origin) rounded-lg border border-popover-border bg-popover p-3 text-popover-foreground outline-none">
            <Popover.Title className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Units per sale
            </Popover.Title>
            <Input
              autoFocus
              type="number"
              inputMode="decimal"
              min={1}
              step="any"
              aria-label="Units per sale"
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                const next = parseMultiplier(event.target.value)
                if (next.ok) onChange(next.value)
              }}
              aria-invalid={!parsed.ok || undefined}
            />
            {!parsed.ok ? (
              <p role="alert" className="mt-1.5 text-xs text-destructive">
                {parsed.error}
              </p>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function CostIssuesCard({ issues }: { issues: ProductDetail["costIssues"] }) {
  return (
    <section
      aria-labelledby="product-cost-issues-heading"
      className="rounded-xl border border-border bg-muted px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert
          className="mt-px size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h2
            id="product-cost-issues-heading"
            className="text-sm font-semibold text-foreground"
          >
            Not accounted for
          </h2>
          <ul className="mt-1.5 flex flex-col gap-1">
            {issues.map((issue, index) => (
              <li
                key={`${issue.code}-${issue.path.join("/")}-${index}`}
                className="text-sm text-muted-foreground"
              >
                {costIssueLine(issue)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

function VariantsCard({ product }: { product: ProductDetail }) {
  const variants = variantGroups(product).flatMap(([, rows]) => rows)
  const { refresh } = useRefresh()
  const [target, setTarget] = React.useState<ProductVariant | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const untrack = async (variant: ProductVariant) => {
    setPending(true)
    setError(null)
    const result = await untrackSalesVariant(variant.id)
    if ("error" in result) {
      setPending(false)
      setError(result.error)
      return
    }
    await refresh()
    setPending(false)
    setTarget(null)
  }
  return (
    <section aria-labelledby="variants-heading">
      <div className="mb-2 flex items-baseline gap-2">
        <h2
          id="variants-heading"
          className="text-lg font-semibold text-foreground"
        >
          Variants
        </h2>
        <span className="text-xs text-faint">{variants.length}</span>
      </div>
      <TableFrame className="overflow-x-auto">
        <Table className="min-w-[560px] table-fixed">
          <TableHeader>
            <TableHeaderRow>
              <TableHead>Variant</TableHead>
              <TableHead className="w-[160px]">SKU</TableHead>
              <TableHead className="w-[140px]">Channel</TableHead>
              <TableHead className="w-[80px] text-right">Units</TableHead>
              <TableHead className="w-11" />
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {variants.length ? (
              variants.map((variant) => (
                <TableRow key={variant.id}>
                  <TableCell className="max-w-0">
                    <span className="block truncate text-md text-foreground">
                      {variantLabel(variant)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {variant.sku.trim() || "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2 text-base text-foreground">
                      {variant.channel === "square" ||
                      variant.channel === "shopify" ? (
                        <ChannelIcon channel={variant.channel} />
                      ) : null}
                      {channelLabel(variant.channel)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {variant.quantityMultiplier > 1 ? (
                      <Badge
                        size="row"
                        variant="secondary"
                        title="Units per sale"
                      >
                        ×{formatMultiplier(variant.quantityMultiplier)}
                      </Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActionsMenu
                      label={`Actions for ${variantLabel(variant)}`}
                    >
                      <MenuItem
                        className="text-destructive data-highlighted:text-destructive"
                        onClick={() => setTarget(variant)}
                      >
                        <Unlink strokeWidth={1.8} aria-hidden="true" />
                        Untrack
                      </MenuItem>
                    </RowActionsMenu>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableEmpty colSpan={5}>No variants yet.</TableEmpty>
            )}
          </TableBody>
        </Table>
      </TableFrame>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setTarget(null)
        }}
        title="Untrack this variant?"
        description={
          <>
            {target ? variantLabel(target) : ""} goes back to Review with its
            sales, where you can link it to another product.
          </>
        }
        confirmLabel={pending ? "Untracking…" : "Untrack variant"}
        pending={pending}
        onConfirm={() => {
          if (target) void untrack(target)
        }}
      />
    </section>
  )
}

/** The whole product screen: identity, components, variants and economics
    behind one Save. */
export function ProductEditor({
  product,
  recipes,
  ingredients,
  products,
  categories,
  salesPeriod,
  salesView,
}: {
  /** Null on /products/new: the same screen, before the product exists. */
  product: ProductDetail | null
  /** Picker sources; the same lists the recipe/ingredient pickers use. */
  recipes: MenuRecipeOption[]
  ingredients: MenuIngredientOption[]
  /** Products this one can contain — a bundle's members. */
  products: MenuProductOption[]
  /** Categories the catalog already uses, for the rail's picker. */
  categories: string[]
  salesPeriod?: { startDate: string; endDate: string }
  salesView?: "expanded" | "asSold"
}) {
  const router = useRouter()
  const { refresh } = useRefresh()
  const settings = useBusinessSettings()
  const {
    dirty,
    setDirty,
    saveState,
    setSaveState,
    saveRef,
    savePending,
    saveLabel,
    save,
  } = useEditChrome()
  const [draft, setDraft] = React.useState(() => draftFrom(product))
  const [components, setComponents] = React.useState<ProductComponentDraft[]>(
    () => (product ? componentDrafts(product) : [])
  )
  const [priceInput, setPriceInput] = React.useState(() =>
    ((product?.sellPriceCents ?? 0) / 100).toFixed(2)
  )
  // The save response is the authority on the version, not the refreshed
  // prop: `refresh()` re-renders the server component under a mounted
  // editor, and reseeding here would clobber whatever is being typed.
  const versionRef = React.useRef(product?.editVersion ?? 0)
  // The rail's figures come with the product; a new one is priced against the
  // workspace's own currency until it has been saved.
  const currencyCode = product?.currencyCode ?? settings.currencyCode

  const setField = <K extends keyof ProductDraft>(
    key: K,
    value: ProductDraft[K]
  ) => setDraft((current) => ({ ...current, [key]: value }))

  // A stored slug this bundle does not recognize — one added after this
  // client loaded — must not be rewritten to "each" by an unrelated save.
  // Omitting the key leaves the saved unit alone; it is sent again once the
  // merchant actively picks a unit this bundle does know.
  const unitPatch =
    product === null ||
    isProductUnit(product.baseUnit) ||
    product.baseUnit === "" ||
    draft.baseUnit !== ""
      ? { baseUnit: draft.baseUnit }
      : {}

  const form = useFormSave({
    // The payload builder doubles as the snapshot, so what reads as dirty is
    // exactly what would be sent: a pure reorder counts, a renamed recipe
    // does not.
    snapshot: JSON.stringify({
      ...draft,
      skus: skusPatch(draft.skus),
      components: componentsPatch(components),
    }),
    validate: (): FormErrors => {
      const errors: FormErrors = {}
      if (!draft.name.trim()) errors[NAME_FIELD] = "Enter a product name."
      if (!Number.isFinite(draft.sellPriceCents) || draft.sellPriceCents < 0) {
        errors[PRICE_FIELD] = "Enter a valid price."
      }
      return {
        ...errors,
        ...validateSkus(draft.skus),
        ...validateComponents(components),
      }
    },
    save: async () => {
      const result = await saveSalesProduct({
        // Detail URLs are public ids; the action validator accepts this ref
        // while catalog variant/member ids remain UUIDs. Null creates.
        id: product?.publicId ?? null,
        ...(product ? { expectedEditVersion: versionRef.current } : {}),
        name: draft.name.trim(),
        skus: skusPatch(draft.skus),
        description: draft.description.trim(),
        category: draft.category.trim(),
        sellPriceCents: draft.sellPriceCents,
        ...unitPatch,
        isActive: draft.isActive,
        components: componentsPatch(components),
      })
      if ("error" in result) return toSaveFailure(result)
      // A create hands the merchant the product it just made, which is where
      // its variants, economics and sales live.
      if (!product) {
        router.replace(productHref(result))
        return null
      }
      versionRef.current = result.editVersion
      refresh()
      return null
    },
  })
  const submit = form.submit

  React.useEffect(() => {
    setDirty(form.dirty)
    setSaveState(form.saveState)
  }, [form.dirty, form.saveState, setDirty, setSaveState])

  React.useEffect(() => {
    saveRef.current = () => submit()
    return () => {
      saveRef.current = null
    }
  }, [submit, saveRef])

  const errors =
    form.errors[NAME_FIELD] ?? form.errors[PRICE_FIELD] ?? form.failure?.message
  const skuError = Object.entries(form.errors).find(([field]) =>
    field.startsWith(SKU_FIELD)
  )?.[1]
  const setSku = (key: string, patch: Partial<SkuDraft>) =>
    setField(
      "skus",
      draft.skus.map((row) => (row.key === key ? { ...row, ...patch } : row))
    )
  const componentsError = Object.entries(form.errors).find(
    ([field]) =>
      field === "product-components" || field.startsWith("component-")
  )?.[1]

  return (
    <>
      <PageHeader className="flex-wrap items-center print:hidden">
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            <PageParent href="/products">Products</PageParent>
          </PageParents>
          <div className="flex min-w-0 items-baseline gap-2.5">
            <PageTitle>
              <span className="truncate">
                {draft.name.trim() || (product?.name ?? "New product")}
              </span>
            </PageTitle>
            <SaveStatus state={saveState} dirty={dirty} saved fallback="" />
          </div>
        </div>
        <SaveButton pending={savePending} label={saveLabel} onSave={save} />
      </PageHeader>

      {/* Fluid main, fixed rail, stacked below xl — the shape Shopify and
          Medusa's product detail both use. */}
      <div
        className={cn(
          "flex w-full flex-col gap-4",
          "xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start xl:gap-x-12"
        )}
      >
        <div className="flex w-full min-w-0 flex-col gap-8">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void form.submit()
            }}
            className="flex flex-col"
          >
            <FieldGroup className="gap-4">
              <Field>
                <FieldTitle>Name (required)</FieldTitle>
                <Input
                  id={NAME_FIELD}
                  // The one thing a new product needs; an existing one opens
                  // for reading, not for typing.
                  autoFocus={product === null}
                  value={draft.name}
                  onChange={(event) => setField("name", event.target.value)}
                  aria-invalid={Boolean(form.errors[NAME_FIELD]) || undefined}
                />
              </Field>
              <Field>
                <FieldTitle>
                  Description{" "}
                  <span className="font-normal text-faint">(Optional)</span>
                </FieldTitle>
                <textarea
                  value={draft.description}
                  rows={3}
                  onChange={(event) =>
                    setField("description", event.target.value)
                  }
                  className="min-h-20 w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-md text-foreground outline-none placeholder:text-faint focus-visible:border-foreground"
                  placeholder="A short note for your team"
                />
              </Field>
              {/* The same band recipes draw between sections. */}
              <div className="mt-3 mb-2 border-t-[6px] border-secondary" />
            </FieldGroup>
            {errors ? (
              <p role="alert" className="mt-4 text-base text-destructive">
                {errors}
              </p>
            ) : null}
          </form>

          <ProductComponentsCard
            rows={components}
            recipes={recipes}
            ingredients={ingredients}
            products={products}
            selfProductId={product?.id ?? null}
            error={componentsError}
            onChange={setComponents}
          />

          {product ? (
            <>
              <VariantsCard product={product} />
              {/* The same band as under Description: sales are not composition. */}
              <div className="mt-3 mb-2 border-t-[6px] border-secondary" />
              <ProductSalesSection
                key={`${salesPeriod?.startDate ?? ""}:${salesPeriod?.endDate ?? ""}:${salesView ?? ""}`}
                product={product}
                period={salesPeriod}
                initialView={salesView}
              />
            </>
          ) : null}
        </div>

        <aside className="flex w-full flex-col gap-3">
          <section
            aria-label="Product organization"
            className="flex flex-col gap-4"
          >
            {/* A product that does not exist yet is created Active; the
                toggle only earns its place once there is one to turn off. */}
            {product ? (
              <Field>
                <FieldTitle>Status</FieldTitle>
                <Select
                  value={draft.isActive ? "active" : "inactive"}
                  onValueChange={(value) =>
                    setField("isActive", value === "active")
                  }
                >
                  <SelectTrigger aria-label="Status">
                    <SelectValue>
                      {draft.isActive ? "Active" : "Inactive"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field>
              <FieldTitle>Category</FieldTitle>
              <ProductCategoryCombobox
                value={draft.category}
                onChange={(next) => setField("category", next)}
                options={categories}
              />
            </Field>
            <Field>
              <FieldTitle>Price ({currencyCode})</FieldTitle>
              {/* The unit lives inside the field, the way amount/unit pairs
                  read on the ingredient panels. */}
              <div className="grid h-9 grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-md border border-input bg-card focus-within:border-foreground hover:border-line-strong">
                <input
                  id={PRICE_FIELD}
                  type="text"
                  inputMode="decimal"
                  value={priceInput}
                  onChange={(event) => {
                    const next = event.target.value
                    setPriceInput(next)
                    const cents = dollarsToCents(next)
                    if (cents !== null) setField("sellPriceCents", cents)
                    else
                      setDraft((current) => ({
                        ...current,
                        sellPriceCents: Number.NaN,
                      }))
                  }}
                  aria-invalid={Boolean(form.errors[PRICE_FIELD]) || undefined}
                  className="min-w-0 bg-transparent px-3 text-md tabular-nums outline-none placeholder:text-faint"
                />
                <UnitCombobox
                  label="Sold by"
                  value={draft.baseUnit || "each"}
                  onChange={(next) =>
                    setField(
                      "baseUnit",
                      !next || next === "each" || !isProductUnit(next)
                        ? ""
                        : next
                    )
                  }
                  options={UNIT_OPTIONS}
                  variant="chip"
                  className="mr-1"
                  popupClassName="w-[205px]"
                />
              </div>
              <FieldDescription>
                What a customer pays. Cost comes from the components below.
              </FieldDescription>
            </Field>
            <Field>
              <FieldTitle>SKU</FieldTitle>
              {/* One row per SKU, each reading like the price field with its
                  units-per-sale chip. */}
              {draft.skus.map((row, index) => (
                <div key={row.key} className="flex items-center gap-1">
                  <div
                    className={cn(
                      "grid h-9 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-md border border-input bg-card focus-within:border-foreground hover:border-line-strong",
                      form.errors[`${SKU_FIELD}-${row.key}`] &&
                        "border-destructive"
                    )}
                  >
                    <input
                      id={`${SKU_FIELD}-${row.key}`}
                      type="text"
                      aria-label={index === 0 ? "SKU" : `SKU ${index + 1}`}
                      value={row.sku}
                      placeholder="SKU"
                      onChange={(event) =>
                        setSku(row.key, { sku: event.target.value })
                      }
                      className="min-w-0 bg-transparent px-3 text-md tabular-nums outline-none placeholder:text-faint"
                    />
                    <span className="mr-1 flex items-center self-center">
                      <span
                        aria-hidden="true"
                        className="pr-1 text-sm text-faint"
                      >
                        /
                      </span>
                      <MultiplierChip
                        value={row.quantityMultiplier}
                        unit={displayUnitShort(draft.baseUnit || "each")}
                        onChange={(quantityMultiplier) =>
                          setSku(row.key, { quantityMultiplier })
                        }
                      />
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Remove SKU"
                    onClick={() =>
                      setField(
                        "skus",
                        draft.skus.filter((other) => other.key !== row.key)
                      )
                    }
                  >
                    <X strokeWidth={1.8} aria-hidden="true" />
                  </Button>
                </div>
              ))}
              {skuError ? (
                <p role="alert" className="text-sm text-destructive">
                  {skuError}
                </p>
              ) : null}
              <FieldDescription>
                The code your POS sends. After the slash, how many units one
                sale is.
              </FieldDescription>
              {/* The field stretches its children; the wrapper takes that, so
                  the button keeps its own width and hover. */}
              <div>
                <AddButton
                  label="Add SKU"
                  disabled={draft.skus.length >= 20}
                  onClick={() => setField("skus", [...draft.skus, newSku()])}
                />
              </div>
            </Field>
          </section>
          {product ? (
            <>
              {product.costIssues.length ? (
                <CostIssuesCard issues={product.costIssues} />
              ) : null}
              {product.incompleteManualRevenue ? (
                <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 size-1.5 shrink-0 rounded-full bg-muted-foreground"
                  />
                  <span>
                    Manual revenue details are incomplete. This summary includes
                    only complete sales lines.
                  </span>
                </div>
              ) : null}
            </>
          ) : null}
        </aside>
      </div>
    </>
  )
}
