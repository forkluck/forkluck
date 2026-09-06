"use client"

import * as React from "react"
import { Box, Boxes, Plus, Trash2 } from "lucide-react"

import { saveMenuItem } from "@/app/(app)/products/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LabeledInput, LabeledShell } from "@/components/ui/labeled-field"
import { Input } from "@/components/ui/input"
import { ProductLinkPicker } from "@/components/menu/product-link-picker"
import {
  componentTargetKey,
  ProductComponentPicker,
} from "@/components/menu/product-components-picker"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/toast"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure, type SaveFailure } from "@/lib/save-failure"
import type { SalesIdentityKind, SalesProductRow } from "@/lib/backend/types"
import { dollarsToCents } from "@/lib/money"
import {
  bundleMembersValidationError,
  channelLabel,
  parseAttributionPercent,
  parseMemberQuantity,
  parseMultiplier,
  salesVariantPayload,
  type BundleMember,
} from "@/lib/sales-identity"
import { cn } from "@/lib/utils"

export type MenuRecipeOption = { id: string; publicId: string; title: string }

export type MenuInitialVariant = {
  channel: "square" | "shopify"
  providerAccountId: string
  matchKey: string
  sku: string
  externalName: string
  externalVariantTitle: string
  identityKind?: SalesIdentityKind
  externalObjectId?: string
  productExternalObjectId?: string
}

type LinkDraft = { id: string; quantity: string }

const linkDrafts = (product?: SalesProductRow): LinkDraft[] =>
  product?.recipeLinks.map((link) => ({
    id: link.recipeId,
    quantity: String(link.quantity),
  })) ?? []

/** A product picked into a box while its units are still being typed. */
type MemberDraft = {
  /** The picker's own target key, so the picked row cannot be picked twice. */
  key: string
  productId: string
  name: string
  quantity: string
}

/** A box is created by this save, so no product can contain it yet. */
const NO_BLOCKED_PRODUCTS: ReadonlySet<string> = new Set()

/**
 * Only worth saying once a number is in the box. Blank is the default and
 * counts for everything, which needs no line of its own.
 */
function attributionHelp(value: string) {
  const text = value.trim()
  if (!text) return null
  const percent = Number(text)
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    return "Enter a whole number between 0 and 100."
  }
  if (percent === 100) return "The whole sale belongs to these products."
  return `${100 - percent}% of the sale stays unattributed.`
}

const NAME_FIELD = "menu-item-name"

/** Everything the form can refuse that is not the name field. */
const ITEM_FIELD = "menu-item"

/**
 * Two shapes: this catalog item is one product sold in some multiple, or it is
 * a box — its own new product, whose components are the products inside it.
 */
const KINDS: Array<{
  value: "product" | "bundle"
  label: string
  help: string
  icon: typeof Box
}> = [
  {
    value: "product",
    label: "One product",
    help: "A set number of one product.",
    icon: Box,
  },
  {
    value: "bundle",
    label: "A box of several products",
    help: "Creates a new bundle product for the box.",
    icon: Boxes,
  },
]

function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor?: string
  children: React.ReactNode
}) {
  const className = "block text-sm font-medium text-foreground"
  return htmlFor ? (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  ) : (
    <span className={className}>{children}</span>
  )
}

function LinkRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_132px_36px] items-center gap-3 px-4 pt-2">
      {children}
    </div>
  )
}

/**
 * Links one catalog identity to a product. Products themselves are made on
 * /products/new, which is the whole screen rather than this dialog.
 */
export function MenuItemDialog({
  product,
  products = [],
  recipes = [],
  open,
  onOpenChange,
  initialName,
  initialVariant,
  onProductChoice,
  onSaved,
}: {
  /**
   * The chosen product, so the save keeps that product's version, recipes and
   * existing variants.
   */
  product?: SalesProductRow
  /** The member picker and the product picker. */
  products?: SalesProductRow[]
  recipes?: MenuRecipeOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
  initialName?: string
  /** The catalog identity this dialog links. */
  initialVariant: MenuInitialVariant
  onProductChoice?: (productId: string | null) => void
  onSaved?: () => void
}) {
  const toast = useToast()
  const [name, setName] = React.useState(product?.name ?? initialName ?? "")
  const [recipeLinks, setRecipeLinks] = React.useState<LinkDraft[]>(() =>
    linkDrafts(product)
  )
  const [kind, setKind] = React.useState<"product" | "bundle">("product")
  const [multiplier, setMultiplier] = React.useState("1")
  const [members, setMembers] = React.useState<MemberDraft[]>([])
  // Blank posts no price: a box may be worth naming before it is worth pricing.
  const [bundlePrice, setBundlePrice] = React.useState("")
  // Blank is the default: stored as null, which counts as the whole sale.
  const [attribution, setAttribution] = React.useState("")
  const [trackMode, setTrackMode] = React.useState(product?.id ?? "new")
  const recipeLabels = React.useMemo(
    () =>
      Object.fromEntries(recipes.map((recipe) => [recipe.id, recipe.title])),
    [recipes]
  )

  const reset = React.useCallback(() => {
    setName(product?.name ?? initialName ?? "")
    setRecipeLinks(linkDrafts(product))
    setKind("product")
    setMultiplier("1")
    setMembers([])
    setBundlePrice("")
    setAttribution("")
    setTrackMode(product?.id ?? "new")
  }, [initialName, product])
  // The dialog outlives a change of linked product, so the fields that come
  // from that product are re-seeded here rather than by a remount.
  const productId = product?.id ?? null
  const seededProductId = React.useRef(productId)
  React.useEffect(() => {
    if (seededProductId.current === productId) return
    seededProductId.current = productId
    setName(product?.name ?? initialName ?? "")
    setRecipeLinks(linkDrafts(product))
  }, [productId, product, initialName])

  // What the controller sends, against what the dialog opened with.
  const snapshot = JSON.stringify([
    name,
    recipeLinks,
    kind,
    multiplier,
    members,
    bundlePrice,
    attribution,
    trackMode,
  ])

  const isBundle = kind === "bundle"
  // Catalog hands this dialog the same rows the Linked tab renders, components
  // included, so a nested box carries its own members and the cycle guard works.
  const memberOptions = React.useMemo(
    () =>
      products
        .filter((row) => row.isActive)
        .map((row) => ({
          id: row.id,
          publicId: row.publicId,
          name: row.name,
          componentProductIds: row.components.flatMap((component) =>
            component.productId ? [component.productId] : []
          ),
        })),
    [products]
  )
  const pickedMemberKeys = React.useMemo(
    () => new Set(members.map((member) => member.key)),
    [members]
  )

  // The typed name counts only where the merchant may type it: naming the new
  // product this catalog item will belong to — a box types its own name too.
  // An existing product keeps the name it already has.
  const usesTypedName = trackMode === "new"
  const linkedProduct =
    product ?? products.find((item) => item.id === trackMode) ?? null
  const displayedName = usesTypedName ? name : (linkedProduct?.name ?? "")

  // Either what the form refuses, or the writes the Save button will run.
  const plan = ():
    { errors: FormErrors } | { run: () => Promise<SaveFailure | null> } => {
    const trimmed = name.trim()
    if (!trimmed && usesTypedName)
      return { errors: { [NAME_FIELD]: "Enter a product name." } }
    if (onProductChoice && trackMode !== "new" && !product) {
      return {
        errors: {
          [NAME_FIELD]: "Choose the product this catalog item represents.",
        },
      }
    }
    const recipePayload: Array<{ recipeId: string; quantity: number }> = []
    for (const link of recipeLinks) {
      const quantity = Number(link.quantity)
      if (
        !link.id ||
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        recipePayload.some((entry) => entry.recipeId === link.id)
      )
        return {
          errors: {
            [ITEM_FIELD]: "Each recipe needs a unique positive quantity.",
          },
        }
      recipePayload.push({ recipeId: link.id, quantity })
    }
    const parsedMembers: BundleMember[] = []
    let variantMultiplier = 1
    let bundlePriceCents: number | null = null
    if (isBundle) {
      for (const member of members) {
        const quantity = parseMemberQuantity(member.quantity)
        if (!quantity.ok) return { errors: { [ITEM_FIELD]: quantity.error } }
        parsedMembers.push({
          productId: member.productId,
          quantity: quantity.value,
        })
      }
      const memberError = bundleMembersValidationError(parsedMembers)
      if (memberError) return { errors: { [ITEM_FIELD]: memberError } }
      if (bundlePrice.trim()) {
        bundlePriceCents = dollarsToCents(bundlePrice)
        if (bundlePriceCents === null) {
          return { errors: { [ITEM_FIELD]: "Enter a price like 24.00." } }
        }
      }
    } else {
      const parsedMultiplier = parseMultiplier(multiplier)
      if (!parsedMultiplier.ok) {
        return { errors: { [ITEM_FIELD]: parsedMultiplier.error } }
      }
      variantMultiplier = parsedMultiplier.value
    }
    let attributionPercent: number | null = null
    if (attribution.trim()) {
      const parsedAttribution = parseAttributionPercent(attribution)
      if (!parsedAttribution.ok) {
        return { errors: { [ITEM_FIELD]: parsedAttribution.error } }
      }
      attributionPercent = parsedAttribution.value
    }
    // A box links to the product this save creates, never to an existing one.
    const targetId = isBundle
      ? null
      : (product?.id ?? (trackMode === "new" ? null : trackMode))
    const targetProduct = isBundle
      ? null
      : (product ?? products.find((item) => item.id === targetId) ?? null)
    if (targetId && !targetProduct) {
      return {
        errors: {
          [ITEM_FIELD]: "The selected product is no longer available.",
        },
      }
    }
    // The typed name wins wherever the field was shown; elsewhere the linked
    // product keeps the name it already has.
    const productName = usesTypedName
      ? trimmed
      : (targetProduct?.name ?? trimmed)
    const productRecipes =
      targetProduct?.recipeLinks.map((link) => ({
        recipeId: link.recipeId,
        quantity: link.quantity,
      })) ?? recipePayload
    const existingVariants =
      targetProduct?.variants
        .filter((variant) => variant.identityKind === "item")
        .map((variant) =>
          salesVariantPayload(
            variant,
            variant.quantityMultiplier,
            variant.attributionPercent
          )
        ) ?? []
    const catalogVariant = salesVariantPayload(
      {
        id: null,
        channel: initialVariant.channel,
        providerAccountId: initialVariant.providerAccountId,
        matchKey: initialVariant.matchKey,
        identityKind: initialVariant.identityKind ?? "item",
        sku: initialVariant.sku,
        externalName: initialVariant.externalName,
        externalVariantTitle: initialVariant.externalVariantTitle,
        externalObjectId: initialVariant.externalObjectId ?? "",
        productExternalObjectId: initialVariant.productExternalObjectId ?? "",
      },
      variantMultiplier,
      attributionPercent
    )
    return {
      run: async () => {
        const result = await saveMenuItem({
          id: targetId,
          expectedEditVersion: targetProduct?.editVersion,
          name: productName,
          isActive: targetProduct?.isActive ?? true,
          recipeLinks: productRecipes,
          ...(bundlePriceCents === null
            ? {}
            : { sellPriceCents: bundlePriceCents }),
          // Only a box replaces its composition here; every other save leaves
          // the product's own components alone.
          ...(isBundle
            ? {
                components: parsedMembers.map((member, position) => ({
                  recipeId: null,
                  ingredientId: null,
                  productId: member.productId,
                  quantity: member.quantity,
                  unit: "",
                  position,
                })),
              }
            : {}),
          variants: [...existingVariants, catalogVariant],
        })
        if ("error" in result) return toSaveFailure(result)
        if (result.claimedLines > 0) {
          toast.add({
            title: `${result.claimedLines} past ${result.claimedLines === 1 ? "sale" : "sales"} now count toward ${productName || "this product"}`,
          })
        }
        return null
      },
    }
  }

  const plannedRun = React.useRef<() => Promise<SaveFailure | null>>(() =>
    Promise.resolve(null)
  )
  const form = useFormSave({
    snapshot,
    // Linking a catalog item writes even when no field was touched.
    saved: false,
    validate: () => {
      const planned = plan()
      if ("errors" in planned) return planned.errors
      plannedRun.current = planned.run
      return {}
    },
    // Validation planned this write a moment ago; only its errors block.
    save: () => plannedRun.current(),
  })
  const { confirm, dialog } = useDirtyDialog()

  const close = (next: boolean) => {
    if (next) reset()
    onOpenChange(next)
  }
  const requestClose = (next: boolean) => {
    if (!next && form.dirty) {
      confirm(true, () => close(false))
      return
    }
    close(next)
  }

  const submit = () =>
    void form.submit().then((done) => {
      if (!done) return
      close(false)
      onSaved?.()
    })

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        size="lg"
        onKeyDown={dialogSaveShortcut(submit)}
        className="top-12 max-h-[calc(100dvh-96px)] translate-y-0 gap-0 overflow-x-hidden overflow-y-auto pb-[22px] [--dialog-px:28px] [--dialog-py:26px]"
      >
        <DialogHeader>
          <DialogTitle className="text-xl">Link catalog item</DialogTitle>
          <DialogDescription className="sr-only">
            Link this catalog item to a product, or to a box of them.
          </DialogDescription>
        </DialogHeader>
        {/* The field is always here. An existing product keeps its own name,
              so linking one disables it and shows what the save will use —
              dropping it instead moved every control below it the moment the
              picker changed. */}
        <LabeledInput
          label="Name"
          id={NAME_FIELD}
          containerClassName="mt-5"
          disabled={!usesTypedName}
          value={displayedName}
          onChange={(event) => setName(event.target.value)}
        />
        {/* min-w-0: a grid item's min-width defaults to its content, so a
            long nowrap item name would otherwise push the whole dialog wider
            than its max and clip everything at the right edge. */}
        <div
          className={cn(
            "mt-4 min-w-0 rounded-xl border border-border px-4 py-3.5",
            // A box links to the product it creates, so the card reads as
            // inert rather than disappearing under the pointer.
            isBundle && "bg-fill-soft text-faint opacity-70"
          )}
        >
          <p
            title={`${initialVariant.externalName}${
              initialVariant.externalVariantTitle
                ? ` · ${initialVariant.externalVariantTitle}`
                : ""
            }`}
            className="truncate text-md font-medium text-foreground"
          >
            {initialVariant.externalName}
            {initialVariant.externalVariantTitle
              ? ` · ${initialVariant.externalVariantTitle}`
              : ""}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {channelLabel(initialVariant.channel)}
            {initialVariant.sku ? ` · SKU ${initialVariant.sku}` : ""}
          </p>
          {onProductChoice ? (
            <LabeledShell label="Product to link" className="mt-3">
              <ProductLinkPicker
                products={products}
                value={trackMode}
                disabled={isBundle}
                onValueChange={(next) => {
                  setTrackMode(next)
                  onProductChoice(next === "new" ? null : next)
                }}
              />
            </LabeledShell>
          ) : null}
        </div>
        <div className="mt-6">
          <FieldLabel>How should this catalog item link?</FieldLabel>
          <div role="radiogroup" className="mt-2 grid gap-3 sm:grid-cols-2">
            {KINDS.map((option) => {
              const Icon = option.icon
              const selected = kind === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    setKind(option.value)
                    // A box gets its own new product, so choosing one
                    // releases whatever product was picked to link.
                    if (option.value === "bundle" && trackMode !== "new") {
                      setTrackMode("new")
                      onProductChoice?.(null)
                    }
                  }}
                  className={cn(
                    "relative rounded-xl border p-4 text-left outline-none",
                    selected
                      ? "border-brand bg-brand-selected"
                      : "border-border bg-card hover:border-line-strong focus-visible:border-foreground"
                  )}
                >
                  <Icon className="size-[17px] text-brand" aria-hidden="true" />
                  <span className="mt-3 block text-md font-semibold text-foreground">
                    {option.label}
                  </span>
                  <span className="mt-1 block text-sm leading-[1.55] text-muted-foreground">
                    {option.help}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
        {kind === "product" ? (
          <LabeledInput
            label="Units per sale"
            id="variant-multiplier"
            inputMode="decimal"
            containerClassName="mt-4 max-w-[180px]"
            className="tabular-nums"
            value={multiplier}
            onChange={(event) => setMultiplier(event.target.value)}
          />
        ) : null}
        <LabeledInput
          label="Counts as % of the sale"
          id="variant-attribution"
          inputMode="numeric"
          containerClassName="mt-4 max-w-[220px]"
          className="tabular-nums"
          value={attribution}
          onChange={(event) => setAttribution(event.target.value)}
        />
        {attributionHelp(attribution) ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {attributionHelp(attribution)}
          </p>
        ) : null}
        {isBundle ? (
          <>
            <LabeledInput
              label="Price"
              id="bundle-price"
              inputMode="decimal"
              containerClassName="mt-4 max-w-[180px]"
              className="tabular-nums"
              value={bundlePrice}
              onChange={(event) => setBundlePrice(event.target.value)}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Optional. What one box sells for.
            </p>
            <div className="mt-4 rounded-xl border border-border p-4">
              <FieldLabel>Products in this box</FieldLabel>
              <p className="mt-1 text-xs text-muted-foreground">
                Say how many of each product one box contains. The box gets its
                own product page, cost and price.
              </p>
              <div className="mt-3 grid gap-2">
                {members.map((member) => (
                  <div
                    key={member.productId}
                    className="grid grid-cols-[minmax(0,1fr)_72px_28px] items-center gap-2"
                  >
                    <span className="truncate text-base text-foreground">
                      {member.name}
                    </span>
                    <Input
                      aria-label={`Units of ${member.name} per box`}
                      inputMode="numeric"
                      className="text-right tabular-nums"
                      value={member.quantity}
                      onChange={(event) =>
                        setMembers((current) =>
                          current.map((row) =>
                            row.productId === member.productId
                              ? { ...row, quantity: event.target.value }
                              : row
                          )
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${member.name}`}
                      onClick={() =>
                        setMembers((current) =>
                          current.filter(
                            (row) => row.productId !== member.productId
                          )
                        )
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <ProductComponentPicker
                  recipes={[]}
                  ingredients={[]}
                  products={memberOptions}
                  selected={pickedMemberKeys}
                  blockedProductIds={NO_BLOCKED_PRODUCTS}
                  onPick={(target) => {
                    if (target.kind !== "product") return
                    setMembers((current) => [
                      ...current,
                      {
                        key: componentTargetKey(target),
                        productId: target.id,
                        name: target.name,
                        quantity: "1",
                      },
                    ])
                  }}
                />
              </div>
            </div>
          </>
        ) : null}
        <div className="mt-6 rounded-xl border border-border">
          <div className="flex items-center justify-between border-b border-muted px-4 py-3">
            <span className="text-md font-semibold text-foreground">
              Recipes
            </span>
            <Button
              variant="outline"
              disabled={!recipes.length}
              onClick={() =>
                setRecipeLinks((current) => [
                  ...current,
                  {
                    id:
                      recipes.find(
                        (recipe) =>
                          !current.some((link) => link.id === recipe.id)
                      )?.id ?? "",
                    quantity: "1",
                  },
                ])
              }
            >
              <Plus aria-hidden="true" />
              Add recipe
            </Button>
          </div>
          {recipeLinks.map((link, index) => (
            <LinkRow key={`${link.id}-${index}`}>
              <Select
                items={recipeLabels}
                value={link.id || null}
                onValueChange={(value) =>
                  setRecipeLinks((current) =>
                    current.map((row, rowIndex) =>
                      rowIndex === index
                        ? { ...row, id: String(value ?? "") }
                        : row
                    )
                  )
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={`Recipe ${index + 1}`}
                >
                  <SelectValue placeholder="Choose recipe" />
                </SelectTrigger>
                <SelectContent>
                  {recipes.map((recipe) => (
                    <SelectItem
                      key={recipe.id}
                      value={recipe.id}
                      disabled={recipeLinks.some(
                        (row, rowIndex) =>
                          rowIndex !== index && row.id === recipe.id
                      )}
                    >
                      {recipe.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                inputMode="decimal"
                value={link.quantity}
                onChange={(event) =>
                  setRecipeLinks((current) =>
                    current.map((row, rowIndex) =>
                      rowIndex === index
                        ? { ...row, quantity: event.target.value }
                        : row
                    )
                  )
                }
              />
              <button
                type="button"
                aria-label="Remove recipe"
                onClick={() =>
                  setRecipeLinks((current) =>
                    current.filter((_, rowIndex) => rowIndex !== index)
                  )
                }
                className="flex size-9 items-center justify-center rounded-lg text-faint hover:bg-destructive-fill hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </LinkRow>
          ))}
        </div>
        {form.errors[NAME_FIELD] || form.errors[ITEM_FIELD] || form.failure ? (
          <p role="alert" className="mt-4 text-base text-destructive">
            {form.errors[NAME_FIELD] ??
              form.errors[ITEM_FIELD] ??
              form.failure?.message}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => requestClose(false)}>
            Cancel
          </Button>
          <Button pending={form.pending} onClick={submit}>
            Save
          </Button>
        </div>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
