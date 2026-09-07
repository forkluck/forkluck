"use client"

import * as React from "react"

import { componentTargetKey } from "@/components/menu/product-components-picker"
import {
  componentFromTarget,
  componentTargets,
  matchTargets,
  newComponentKey,
  type ComponentTarget,
} from "@/components/menus/component-targets"
import { UnitCombobox } from "@/components/ingredients/unit-combobox"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SearchInput } from "@/components/ui/input"
import { TabPill, TabPills } from "@/components/ui/tab-pills"
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
import {
  batchUnitOptions,
  recipeUnitOptions,
  unitShort,
} from "@/lib/unit-registry"
import type {
  MenuIngredientOption,
  MenuProductOption,
  MenuRecipeOption,
} from "@/lib/backend/types"
import type { ProductComponentDraft } from "@/components/menu/product-components"

const UNIT_OPTIONS = recipeUnitOptions()

const TABS = ["Ingredients", "Recipes", "Products", "Supplies"] as const
type Tab = (typeof TABS)[number]

function targetTab(target: ComponentTarget): Tab {
  if (target.kind === "recipe") return "Recipes"
  if (target.kind === "product") return "Products"
  return target.nonEdible ? "Supplies" : "Ingredients"
}

/** The quiet second column: what the row is, what a batch of it makes, or
    what an ingredient is bought in. */
function targetDetail(target: ComponentTarget) {
  if (target.kind === "recipe") {
    const batch = target.recipe.batchMeasures[0]
    return batch
      ? `Recipe · ${batch.amount.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${unitShort(batch.unit)}/batch`
      : "Recipe"
  }
  if (target.kind === "product") return "Product"
  return target.purchaseUnit ?? ""
}

/** What a checked row starts as: one unit, in the ingredient's own unit. */
function targetDraft(target: ComponentTarget): ProductComponentDraft {
  if (target.kind === "product")
    return {
      key: newComponentKey(),
      recipeId: null,
      recipePublicId: null,
      recipeName: null,
      ingredientId: null,
      ingredientPublicId: null,
      ingredientName: null,
      productId: target.id,
      productPublicId: target.publicId,
      productName: target.name,
      quantity: 1,
      unit: "",
      nonEdible: false,
    }
  const component = componentFromTarget(target)
  const recipe = target.kind === "recipe" ? target.recipe : null
  return {
    key: component.key,
    recipeId: component.recipeId,
    recipePublicId: recipe?.publicId ?? null,
    recipeName: recipe?.title ?? null,
    ingredientId: component.ingredientId,
    ingredientPublicId: null,
    ingredientName: recipe ? null : target.name,
    productId: null,
    productPublicId: null,
    productName: null,
    quantity: component.quantity,
    unit: component.unit,
    nonEdible: target.kind === "ingredient" ? target.nonEdible : false,
  }
}

export function AddComponentsDialog({
  open,
  onOpenChange,
  recipes,
  ingredients,
  products,
  selected,
  blockedProductIds,
  remaining,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  recipes: MenuRecipeOption[]
  ingredients: MenuIngredientOption[]
  products: MenuProductOption[]
  /** Target keys the product already links, shown checked and inert. */
  selected: ReadonlySet<string>
  /** Self and anything that already reaches it — a cycle the server refuses. */
  blockedProductIds: ReadonlySet<string>
  /** How many more components the product may hold. */
  remaining: number
  onAdd: (drafts: ProductComponentDraft[]) => void
}) {
  const [tab, setTab] = React.useState<Tab>("Ingredients")
  const [query, setQuery] = React.useState("")
  const [picked, setPicked] = React.useState<
    Record<string, ProductComponentDraft>
  >({})

  const targets = React.useMemo(
    () => componentTargets(recipes, ingredients, products),
    [ingredients, products, recipes]
  )
  const rows = React.useMemo(
    () =>
      matchTargets(
        targets.filter(
          (target) =>
            targetTab(target) === tab &&
            !(target.kind === "product" && blockedProductIds.has(target.id))
        ),
        query
      ),
    [blockedProductIds, query, tab, targets]
  )

  const chosen = Object.values(picked)
  const tooMany = chosen.length > remaining

  const toggle = (target: ComponentTarget) =>
    setPicked((current) => {
      const key = componentTargetKey(target)
      const next = { ...current }
      if (next[key]) delete next[key]
      else next[key] = targetDraft(target)
      return next
    })
  const patch = (key: string, part: Partial<ProductComponentDraft>) =>
    setPicked((current) => ({
      ...current,
      [key]: { ...current[key]!, ...part },
    }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* One fixed height: switching tabs or narrowing the search moves the
          rows, never the dialog. Only the table scrolls. */}
      <DialogContent size="lg" className="flex h-[min(640px,85dvh)] flex-col">
        <DialogHeader>
          <DialogTitle>Add components</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-3">
          {/* Four pills are wider than a phone dialog: the track scrolls. */}
          <TabPills className="min-w-0 shrink overflow-x-auto">
            {TABS.map((name) => (
              <TabPill
                key={name}
                active={tab === name}
                onClick={() => setTab(name)}
              >
                {name}
              </TabPill>
            ))}
          </TabPills>
          <SearchInput
            className="max-w-none md:max-w-[196px]"
            value={query}
            label={`Search ${tab.toLocaleLowerCase()}`}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <TableFrame className="min-h-0 flex-1 overflow-auto">
          <Table className="min-w-[480px] table-fixed">
            <TableHeader>
              <TableHeaderRow>
                <TableHead className="w-9" />
                <TableHead>Name</TableHead>
                <TableHead className="w-[110px]">Detail</TableHead>
                <TableHead className="w-[200px]">Quantity</TableHead>
              </TableHeaderRow>
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map((target) => {
                  const key = componentTargetKey(target)
                  const linked = selected.has(key)
                  const draft = picked[key]
                  return (
                    <TableRow
                      key={key}
                      onClick={() => !linked && toggle(target)}
                    >
                      {/* The box handles its own click; the row must not
                          toggle it a second time. */}
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          aria-label={target.name}
                          disabled={linked}
                          checked={linked || Boolean(draft)}
                          onCheckedChange={() => toggle(target)}
                        />
                      </TableCell>
                      <TableCell className="max-w-0 truncate text-md">
                        {target.name}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {targetDetail(target)}
                      </TableCell>
                      <TableCell>
                        {draft ? (
                          // Same amount-and-unit box the linked rows use.
                          <div
                            onClick={(event) => event.stopPropagation()}
                            className="grid h-8 grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-md border border-input bg-card focus-within:border-foreground hover:border-line-strong"
                          >
                            <input
                              type="text"
                              inputMode="decimal"
                              aria-label={`Quantity for ${target.name}`}
                              value={
                                Number.isNaN(draft.quantity)
                                  ? ""
                                  : String(draft.quantity)
                              }
                              onChange={(event) =>
                                patch(key, {
                                  quantity: Number(event.target.value),
                                })
                              }
                              className="min-w-0 bg-transparent px-3 text-md tabular-nums outline-none"
                            />
                            {target.kind === "product" ? null : (
                              <UnitCombobox
                                label={target.name}
                                value={draft.unit}
                                onChange={(unit) =>
                                  patch(key, { unit: unit ?? "" })
                                }
                                options={
                                  target.kind === "recipe"
                                    ? batchUnitOptions(target.recipe)
                                    : UNIT_OPTIONS
                                }
                                emptyLabel={
                                  target.kind === "recipe"
                                    ? "batches"
                                    : undefined
                                }
                                variant="chip"
                                className="mr-1"
                                popupClassName="w-[205px]"
                              />
                            )}
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )
                })
              ) : (
                <TableEmpty colSpan={4}>
                  No {tab.toLocaleLowerCase()} found.
                </TableEmpty>
              )}
            </TableBody>
          </Table>
        </TableFrame>

        {tooMany ? (
          <p className="text-xs text-destructive">
            At most {remaining} more can be added.
          </p>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {chosen.length} selected
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={chosen.length === 0 || tooMany}
              onClick={() => onAdd(chosen)}
            >
              Add
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
