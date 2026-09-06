"use client"

import * as React from "react"
import { Trash2 } from "lucide-react"

import { GuardedLink } from "@/components/navigation-blocker"
import { AddComponentsDialog } from "@/components/menu/add-components-dialog"
import { Badge } from "@/components/ui/badge"
import { AddButton } from "@/components/ui/add-button"
import { MenuItem } from "@/components/ui/menu"
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
import { UnitCombobox } from "@/components/ingredients/unit-combobox"
import {
  batchUnitOptions,
  recipeUnitOptions,
  unitShort,
} from "@/lib/unit-registry"
import type { FormErrors } from "@/hooks/use-form-save"
import type {
  MenuIngredientOption,
  MenuProductOption,
  MenuRecipeOption,
  ProductComponent,
  ProductDetail,
} from "@/lib/backend/types"

const COMPONENTS_FIELD = "product-components"
const UNIT_OPTIONS = recipeUnitOptions()
export const MAX_COMPONENTS = 100

export type ProductComponentDraft = Pick<
  ProductComponent,
  | "recipeId"
  | "recipePublicId"
  | "recipeName"
  | "ingredientId"
  | "ingredientPublicId"
  | "ingredientName"
  | "productId"
  | "productPublicId"
  | "productName"
  | "quantity"
  | "unit"
  | "nonEdible"
> & {
  key: string
}

export function componentSection(
  component: Pick<ProductComponentDraft, "recipeId" | "productId" | "nonEdible">
): "Recipes" | "Ingredients" | "Products" | "Supplies" {
  if (component.productId) return "Products"
  if (component.recipeId) return "Recipes"
  return component.nonEdible ? "Supplies" : "Ingredients"
}

/** Products that cannot be a component of `productId`: itself, and every
    product whose composition already reaches it. The server is the authority —
    this is a page-load snapshot — but the obvious loop never reaches the
    picker. */
export function blockedComponentProducts(
  /** Null while the product is being created: nothing can contain it yet. */
  productId: string | null,
  products: readonly MenuProductOption[]
): ReadonlySet<string> {
  const containers = new Map<string, string[]>()
  for (const product of products)
    for (const memberId of product.componentProductIds)
      containers.set(memberId, [
        ...(containers.get(memberId) ?? []),
        product.id,
      ])
  const blocked = new Set(productId === null ? [] : [productId])
  const pending = productId === null ? [] : [productId]
  while (pending.length) {
    for (const container of containers.get(pending.pop()!) ?? []) {
      if (blocked.has(container)) continue
      blocked.add(container)
      pending.push(container)
    }
  }
  return blocked
}

function draftFromRow(component: ProductComponent): ProductComponentDraft {
  return {
    key: component.id,
    recipeId: component.recipeId,
    recipePublicId: component.recipePublicId,
    recipeName: component.recipeName,
    ingredientId: component.ingredientId,
    ingredientPublicId: component.ingredientPublicId,
    ingredientName: component.ingredientName,
    productId: component.productId,
    productPublicId: component.productPublicId,
    productName: component.productName,
    quantity: component.quantity,
    unit: component.unit,
    nonEdible: component.nonEdible,
  }
}

/** Saved rows in stored order — the editor's initial component state. */
export function componentDrafts(product: ProductDetail) {
  return [...product.components]
    .sort((left, right) => left.position - right.position)
    .map(draftFromRow)
}

/** The full-replacement list the action takes; also the snapshot's component
    half, so a pure reorder reads as dirty and a renamed recipe does not. */
export function componentsPatch(rows: ProductComponentDraft[]) {
  return rows.map((component, position) => ({
    recipeId: component.recipeId,
    ingredientId: component.ingredientId,
    productId: component.productId,
    quantity: component.quantity,
    unit: component.unit.trim(),
    position,
  }))
}

/** Field id → message, keyed on the row control that is wrong so the form's
    focus lands on it. */
export function validateComponents(rows: ProductComponentDraft[]): FormErrors {
  if (rows.length > MAX_COMPONENTS)
    return { [COMPONENTS_FIELD]: `Use at most ${MAX_COMPONENTS} components.` }
  for (const component of rows) {
    const targets = [
      component.recipeId,
      component.ingredientId,
      component.productId,
    ].filter((id) => id !== null)
    if (targets.length !== 1)
      return {
        [COMPONENTS_FIELD]:
          "Each row needs exactly one recipe, product or ingredient.",
      }
    if (
      !Number.isFinite(component.quantity) ||
      component.quantity <= 0 ||
      component.quantity > 1_000_000
    )
      return {
        [`component-quantity-${component.key}`]:
          "Each component needs a positive quantity.",
      }
    // A box holds three mooncakes, never 2.5 of them.
    if (component.productId && !Number.isInteger(component.quantity))
      return {
        [`component-quantity-${component.key}`]:
          "A product component needs a whole number of units.",
      }
    // An ingredient is measured; a product counts whole members; a recipe
    // takes either, blank meaning whole batches.
    if (component.ingredientId !== null && !component.unit.trim())
      return {
        [`component-unit-${component.key}`]:
          "Ingredient components need a unit.",
      }
    if (component.productId !== null && component.unit !== "")
      return {
        [`component-unit-${component.key}`]:
          "Product components do not use a unit.",
      }
  }
  return {}
}

/** "1 batch = 20 kg · 40 pcs": what a recipe row's measured unit divides. */
export function batchHint(recipe: MenuRecipeOption) {
  if (recipe.batchMeasures.length === 0) return null
  return `1 batch = ${recipe.batchMeasures
    .map(
      (measure) =>
        `${measure.amount.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${unitShort(measure.unit)}`
    )
    .join(" · ")}`
}

function componentName(component: ProductComponentDraft) {
  return (
    (
      component.recipeName ??
      component.ingredientName ??
      component.productName ??
      ""
    ).trim() || "Unnamed component"
  )
}

function componentHref(component: ProductComponentDraft) {
  if (component.productPublicId)
    return `/products/${encodeURIComponent(component.productPublicId)}`
  if (component.recipePublicId)
    return `/recipes/${encodeURIComponent(component.recipePublicId)}/recipe`
  if (component.ingredientPublicId)
    return `/ingredients/${encodeURIComponent(component.ingredientPublicId)}/ingredient`
  return null
}

function ComponentRow({
  component,
  recipe,
  onChange,
  onRemove,
}: {
  component: ProductComponentDraft
  /** The recipe a recipe row names, when the picker still lists it. */
  recipe?: MenuRecipeOption
  onChange: (patch: Partial<ProductComponentDraft>) => void
  onRemove: () => void
}) {
  const name = componentName(component)
  const href = componentHref(component)
  const hint = recipe ? batchHint(recipe) : null
  return (
    <TableRow>
      <TableCell className="max-w-0">
        <span className="flex min-w-0 items-center gap-2">
          {href ? (
            <GuardedLink
              href={href}
              className="truncate rounded-sm text-md text-foreground outline-none hover:underline focus-visible:underline"
            >
              {name}
            </GuardedLink>
          ) : (
            <span className="truncate text-md text-foreground">{name}</span>
          )}
          <Badge size="row" variant="secondary">
            {component.productId
              ? "Product"
              : component.recipeId
                ? "Recipe"
                : "Ingredient"}
          </Badge>
          {component.nonEdible ? (
            <Badge size="row" variant="outline">
              Supply
            </Badge>
          ) : null}
        </span>
        {hint ? (
          <span className="block truncate text-xs text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        {/* Amount and unit share one box, the way every measured field does.
            Products count whole members, so they carry no unit; a recipe row's
            unit is a share of the batch, and blank reads "batches". */}
        <div className="grid h-8 grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-md border border-input bg-card focus-within:border-foreground hover:border-line-strong">
          <input
            id={`component-quantity-${component.key}`}
            type="text"
            inputMode="decimal"
            aria-label={`Quantity for ${name}`}
            value={
              Number.isNaN(component.quantity) ? "" : String(component.quantity)
            }
            onChange={(event) =>
              onChange({ quantity: Number(event.target.value) })
            }
            className="min-w-0 bg-transparent px-3 text-md tabular-nums outline-none"
          />
          {component.productId ? null : (
            <UnitCombobox
              label={name}
              value={component.unit}
              onChange={(unit) => onChange({ unit: unit ?? "" })}
              options={
                component.recipeId
                  ? recipe
                    ? batchUnitOptions(recipe)
                    : UNIT_OPTIONS
                  : UNIT_OPTIONS
              }
              emptyLabel={component.recipeId ? "batches" : undefined}
              variant="chip"
              className="mr-1"
              popupClassName="w-[205px]"
            />
          )}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <RowActionsMenu label={`Actions for ${name}`}>
          <MenuItem
            className="text-destructive data-highlighted:text-destructive"
            onClick={onRemove}
          >
            <Trash2 strokeWidth={1.8} aria-hidden="true" />
            Remove
          </MenuItem>
        </RowActionsMenu>
      </TableCell>
    </TableRow>
  )
}

export function ProductComponentsCard({
  rows,
  recipes,
  ingredients,
  products,
  selfProductId,
  error,
  onChange,
}: {
  rows: ProductComponentDraft[]
  recipes: MenuRecipeOption[]
  ingredients: MenuIngredientOption[]
  products: MenuProductOption[]
  /** The product being edited — never its own component. Null while new. */
  selfProductId: string | null
  /** The merged form's message for this card, already picked by the editor. */
  error?: string
  onChange: (next: ProductComponentDraft[]) => void
}) {
  const selected = React.useMemo(
    () =>
      new Set(
        rows.map((component) =>
          component.productId
            ? `product:${component.productId}`
            : component.recipeId
              ? `recipe:${component.recipeId}`
              : `ingredient:${component.ingredientId}`
        )
      ),
    [rows]
  )
  const blockedProductIds = React.useMemo(
    () => blockedComponentProducts(selfProductId, products),
    [products, selfProductId]
  )
  const recipesById = React.useMemo(
    () => new Map(recipes.map((recipe) => [recipe.id, recipe])),
    [recipes]
  )
  const patchAt = (key: string, patch: Partial<ProductComponentDraft>) =>
    onChange(
      rows.map((component) =>
        component.key === key ? { ...component, ...patch } : component
      )
    )
  const [adding, setAdding] = React.useState(false)
  const add = (drafts: ProductComponentDraft[]) => {
    onChange([...rows, ...drafts])
    setAdding(false)
  }

  const renderSection = (
    label: string,
    sectionRows: ProductComponentDraft[]
  ) => (
    <section aria-labelledby={`product-${label.toLowerCase()}-heading`}>
      <div className="mb-2 flex items-baseline gap-2">
        <h3
          id={`product-${label.toLowerCase()}-heading`}
          className="text-lg font-semibold text-foreground"
        >
          {label}
        </h3>
        <span className="text-xs text-faint">{sectionRows.length}</span>
      </div>
      <TableFrame className="overflow-x-auto">
        <Table className="min-w-[420px] table-fixed">
          <TableHeader>
            <TableHeaderRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-[200px]">Quantity</TableHead>
              <TableHead className="w-11" />
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {sectionRows.length ? (
              sectionRows.map((component) => (
                <ComponentRow
                  key={component.key}
                  component={component}
                  recipe={
                    component.recipeId
                      ? recipesById.get(component.recipeId)
                      : undefined
                  }
                  onChange={(patch) => patchAt(component.key, patch)}
                  onRemove={() =>
                    onChange(rows.filter((row) => row.key !== component.key))
                  }
                />
              ))
            ) : (
              <TableEmpty colSpan={3}>
                No {label.toLocaleLowerCase()} linked.
              </TableEmpty>
            )}
          </TableBody>
        </Table>
      </TableFrame>
    </section>
  )

  return (
    // The section carries the over-the-limit error's field id, so it has to be
    // focusable for the form to land on it.
    <section
      id={COMPONENTS_FIELD}
      tabIndex={-1}
      aria-labelledby="product-composition-heading"
      className="flex flex-col gap-5 outline-none"
    >
      <div className="flex items-center justify-between gap-4">
        <h2
          id="product-composition-heading"
          className="text-lg font-semibold text-foreground"
        >
          Product composition
        </h2>
        <AddButton
          label="Add component"
          variant="outline"
          disabled={rows.length >= MAX_COMPONENTS}
          onClick={() => setAdding(true)}
        />
      </div>
      {adding ? (
        <AddComponentsDialog
          open
          onOpenChange={setAdding}
          recipes={recipes}
          ingredients={ingredients}
          products={products}
          selected={selected}
          blockedProductIds={blockedProductIds}
          remaining={MAX_COMPONENTS - rows.length}
          onAdd={add}
        />
      ) : null}

      {renderSection(
        "Recipes",
        rows.filter((component) => componentSection(component) === "Recipes")
      )}
      {renderSection(
        "Ingredients",
        rows.filter(
          (component) => componentSection(component) === "Ingredients"
        )
      )}
      {renderSection(
        "Products",
        rows.filter((component) => componentSection(component) === "Products")
      )}
      {renderSection(
        "Supplies",
        rows.filter((component) => componentSection(component) === "Supplies")
      )}

      {error ? (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
