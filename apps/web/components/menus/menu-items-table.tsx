"use client"

import * as React from "react"
import {
  Check,
  ChevronDown,
  CircleDollarSign,
  SquarePen,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"

import {
  AlertFlag,
  SortHeader,
  useSortState,
  sortRows,
} from "@/components/menu/product-cells"
import {
  componentTargets,
  matchTargets,
  navigateSuggestions,
  TargetSuggestions,
  type ComponentTarget,
} from "@/components/menus/component-targets"
import { GuardedLink } from "@/components/navigation-blocker"
import { AddButton } from "@/components/ui/add-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BulkDeleteMenu } from "@/components/ui/bulk-delete-menu"
import { Checkbox } from "@/components/ui/checkbox"
import { ColumnsMenu } from "@/components/ui/columns-menu"
import { Input } from "@/components/ui/input"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
import type {
  MenuItemOriginal,
  MenuProductOption,
  MenuRecipeOption,
} from "@/lib/backend/types"
import { MENU_CLASS_LABELS, type DerivedRow } from "@/lib/menu/engineering"
import {
  centsToDollarInput,
  dollarsToCents,
  formatCents,
  percentFormat,
  quantityFormat,
} from "@/lib/money"
import { productHref } from "@/lib/product-href"
import { cn } from "@/lib/utils"

/** The picker's two kinds: a menu item is a recipe or a product, never more. */
export type MenuLinkTarget = Extract<
  ComponentTarget,
  { kind: "recipe" | "product" }
>

export type MenuItemState = {
  key: string
  id: string | null
  /** The link's name; an unlinked leftover keeps the name it was saved with. */
  name: string
  category: string
  sellPriceCents: number
  qtySold: number
  recipeId: string | null
  recipePublicId: string | null
  productId: string | null
  productPublicId: string | null
  foodCostCents: number | null
  sourceSellPriceCents: number | null
  sourceQtySold: number | null
  /** Null until the row has been saved once, which is what takes its snapshot. */
  original: MenuItemOriginal | null
}

/** A patch, or one computed from the row as it is when the patch lands. */
export type MenuItemPatch =
  Partial<MenuItemState> | ((item: MenuItemState) => Partial<MenuItemState>)

const cellInput =
  "h-8 rounded-md border-transparent bg-transparent px-2 text-base md:text-base enabled:not-focus:hover:border-transparent disabled:border-transparent disabled:bg-transparent"

const PRICE_CENTS_LIMIT = 100_000_000
const QTY_LIMIT = 1_000_000
const COLUMNS_KEY = "menu.items.columns"

/** The columns a worksheet starts without; the columns menu offers them. */
const HIDDEN_BY_DEFAULT = ["menuMix", "class"]

const HIDEABLE = [
  { id: "category", label: "Category" },
  { id: "foodCost", label: "Food cost" },
  { id: "foodCostPercent", label: "Food cost %" },
  { id: "margin", label: "Margin" },
  { id: "revenue", label: "Revenue" },
  { id: "profit", label: "Gross profit" },
  { id: "shareOfSales", label: "% of sales" },
  { id: "menuMix", label: "Menu mix %" },
  { id: "class", label: "Class" },
] as const

type SortKey =
  | "name"
  | "category"
  | "foodCost"
  | "price"
  | "qty"
  | "foodCostPercent"
  | "margin"
  | "revenue"
  | "profit"
  | "shareOfSales"
  | "menuMix"
  | "class"

type WorksheetRow = {
  item: MenuItemState
  derived: DerivedRow
}

const numberCell = "text-right text-base text-muted-foreground tabular-nums"

function money(cents: number | null, currencyCode: string) {
  return cents === null ? "—" : formatCents(cents, currencyCode)
}

function percent(ratio: number | null) {
  return ratio === null ? "—" : percentFormat.format(ratio)
}

function PriceCell({
  item,
  onPatch,
}: {
  item: MenuItemState
  onPatch: (key: string, patch: Partial<MenuItemState>) => void
}) {
  // Null while the row rests, so the cell shows the formatted amount until it
  // is being typed in.
  const [draft, setDraft] = React.useState<string | null>(null)
  return (
    <Input
      className={cn(cellInput, "-mr-2 text-right tabular-nums")}
      type="text"
      inputMode="decimal"
      value={draft ?? centsToDollarInput(item.sellPriceCents)}
      aria-label="Sell price"
      onFocus={() => setDraft(centsToDollarInput(item.sellPriceCents))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === null) return
        const text = draft.trim()
        setDraft(null)
        const cents = dollarsToCents(text)
        if (cents === null) return
        onPatch(item.key, {
          sellPriceCents: Math.min(cents, PRICE_CENTS_LIMIT),
        })
      }}
    />
  )
}

function QtyCell({
  item,
  onPatch,
}: {
  item: MenuItemState
  onPatch: (key: string, patch: Partial<MenuItemState>) => void
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  return (
    <Input
      className={cn(cellInput, "-mr-2 text-right tabular-nums")}
      type="text"
      inputMode="decimal"
      value={draft ?? quantityFormat.format(item.qtySold)}
      aria-label="Qty sold"
      onFocus={() => setDraft(String(item.qtySold))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === null) return
        const text = draft.trim()
        setDraft(null)
        // Blank is a real answer: nothing sold yet.
        if (!text) {
          onPatch(item.key, { qtySold: 0 })
          return
        }
        const amount = Number(text)
        if (!Number.isFinite(amount) || amount < 0) return
        onPatch(item.key, {
          qtySold: Math.round(Math.min(amount, QTY_LIMIT) * 1000) / 1000,
        })
      }}
    />
  )
}

/** The two rows a typed name that matches nothing offers to make. */
function createFooters(
  text: string,
  targets: MenuLinkTarget[],
  onCreateRecipe: (name: string) => void,
  onCreateProduct: (name: string) => void
) {
  const typed = text.trim()
  const taken = targets.some(
    (target) => target.name.toLocaleLowerCase() === typed.toLocaleLowerCase()
  )
  if (!typed || taken) return undefined
  return [
    { label: `Add recipe “${typed}”`, onClick: () => onCreateRecipe(typed) },
    { label: `Add product “${typed}”`, onClick: () => onCreateProduct(typed) },
  ]
}

/**
 * An unlinked row is a legal value: it keeps the name it was typed with and
 * says on the field itself that nothing prices it yet. The triangle reopens
 * the suggestions, so the fix is the field rather than a third surface.
 */
function ItemNameCell({
  item,
  autoFocus,
  targets,
  onPatch,
  onPick,
  onCreateRecipe,
  onCreateProduct,
}: {
  item: MenuItemState
  autoFocus: boolean
  targets: MenuLinkTarget[]
  onPatch: (key: string, patch: Partial<MenuItemState>) => void
  onPick: (target: MenuLinkTarget) => void
  onCreateRecipe: (name: string) => void
  onCreateProduct: (name: string) => void
}) {
  const [query, setQuery] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const [highlighted, setHighlighted] = React.useState(-1)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const value = query ?? item.name
  const rows = React.useMemo(
    () => (value.trim() ? matchTargets(targets, value) : []),
    [targets, value]
  )
  return (
    <div className="relative">
      <Input
        ref={inputRef}
        autoFocus={autoFocus}
        className={cn(
          cellInput,
          "-ml-2 border-warning-border pr-8 focus-visible:border-warning enabled:not-focus:hover:border-warning-border"
        )}
        value={value}
        placeholder="Search recipes and products"
        role="combobox"
        aria-expanded={open}
        aria-label="Item name"
        onFocus={(event) => {
          // A filled field opens on its own name, selected so typing replaces it.
          if (item.name) {
            event.target.select()
            setQuery(item.name)
          }
          setOpen(true)
        }}
        onChange={(event) => {
          setQuery(event.target.value)
          setHighlighted(-1)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (navigateSuggestions(event, rows.length, setHighlighted)) {
            if (event.key === "Escape") setOpen(false)
            return
          }
          if (event.key !== "Enter") return
          event.preventDefault()
          const row = highlighted >= 0 ? rows[highlighted] : null
          if (row) onPick(row)
        }}
        onBlur={() => {
          setOpen(false)
          setHighlighted(-1)
          // Typing a name and clicking away keeps the name; no link is forced.
          if (query !== null && query !== item.name) {
            onPatch(item.key, { name: query })
          }
          setQuery(null)
        }}
      />
      {item.name ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Not linked: pick a recipe or a product"
                className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-warning outline-none hover:bg-warning-fill focus-visible:bg-warning-fill"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => inputRef.current?.focus()}
              />
            }
          >
            <TriangleAlert
              className="size-[15px]"
              strokeWidth={1.9}
              aria-hidden="true"
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px]">
            Not one of your recipes or products, so it can’t be costed. Pick one
            from the list, or keep it as typed.
          </TooltipContent>
        </Tooltip>
      ) : null}
      {open && query !== null && query.trim() ? (
        <TargetSuggestions
          anchor={inputRef}
          rows={rows}
          highlighted={highlighted}
          onPick={onPick}
          footers={createFooters(
            value,
            targets,
            onCreateRecipe,
            onCreateProduct
          )}
        />
      ) : null}
    </div>
  )
}

/** Adds a row without reaching for the table: a match lands linked, anything
 * else lands as a named row awaiting one. */
function QuickAdd({
  targets,
  onAddNamed,
  onPick,
  onCreateRecipe,
  onCreateProduct,
}: {
  targets: MenuLinkTarget[]
  onAddNamed: (name: string) => void
  onPick: (target: MenuLinkTarget) => void
  onCreateRecipe: (name: string) => void
  onCreateProduct: (name: string) => void
}) {
  const [text, setText] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const [highlighted, setHighlighted] = React.useState(-1)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const rows = React.useMemo(
    () => (text.trim() ? matchTargets(targets, text) : []),
    [targets, text]
  )
  const clear = () => {
    setText("")
    setOpen(false)
    setHighlighted(-1)
  }
  const pick = (target: MenuLinkTarget) => {
    clear()
    onPick(target)
  }
  return (
    <div className="relative mt-2">
      <Input
        ref={inputRef}
        className="h-8 text-base"
        value={text}
        placeholder="Add an item"
        aria-label="Quick add item"
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false)
          setHighlighted(-1)
        }}
        onChange={(event) => {
          setText(event.target.value)
          setHighlighted(-1)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (navigateSuggestions(event, rows.length, setHighlighted)) {
            if (event.key === "Escape") setOpen(false)
            return
          }
          if (event.key !== "Enter") return
          event.preventDefault()
          const row = highlighted >= 0 ? rows[highlighted] : null
          if (row) {
            pick(row)
            return
          }
          const name = text.trim()
          if (!name) return
          clear()
          onAddNamed(name)
        }}
      />
      {open && text.trim() ? (
        <TargetSuggestions
          anchor={inputRef}
          rows={rows}
          highlighted={highlighted}
          onPick={pick}
          footers={createFooters(
            text,
            targets,
            (name) => {
              clear()
              onCreateRecipe(name)
            },
            (name) => {
              clear()
              onCreateProduct(name)
            }
          )}
        />
      ) : null}
    </div>
  )
}

export function MenuItemsTable({
  items,
  derived,
  recipes,
  products,
  currencyCode,
  onPatch,
  onLinkTarget,
  onCreateRecipe,
  onCreateProduct,
  onAdd,
  onRemove,
}: {
  items: MenuItemState[]
  /** Index-aligned with `items`. */
  derived: DerivedRow[]
  recipes: MenuRecipeOption[]
  products: MenuProductOption[]
  currencyCode: string
  onPatch: (key: string, patch: MenuItemPatch) => void
  onLinkTarget: (key: string, target: MenuLinkTarget) => void
  onCreateRecipe: (key: string, name: string) => void
  onCreateProduct: (key: string, name: string) => void
  onAdd: (partial?: Partial<MenuItemState>) => string
  onRemove: (key: string) => void
}) {
  const [hidden, setHidden] = React.useState<string[]>(HIDDEN_BY_DEFAULT)
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [focusKey, setFocusKey] = React.useState<string | null>(null)
  const { sort, toggle, directionFor } = useSortState<SortKey>()

  // This browser's last choice. Read after mount: the server cannot know what
  // this browser prefers.
  React.useEffect(() => {
    const stored = window.localStorage.getItem(COLUMNS_KEY)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHidden(
      stored === null ? HIDDEN_BY_DEFAULT : stored.split(",").filter(Boolean)
    )
  }, [])
  const shown = (id: string) => !hidden.includes(id)
  const toggleColumn = (id: string, visible: boolean) => {
    const next = visible ? hidden.filter((one) => one !== id) : [...hidden, id]
    setHidden(next)
    window.localStorage.setItem(COLUMNS_KEY, next.join(","))
  }

  const targets = React.useMemo(
    () =>
      componentTargets(recipes, [], products).filter(
        (target): target is MenuLinkTarget => target.kind !== "ingredient"
      ),
    [recipes, products]
  )
  // A link may sit on one row only, so a taken one leaves the picker.
  const openTargets = React.useMemo(() => {
    const taken = new Set<string>()
    for (const item of items) {
      if (item.recipeId) taken.add(`recipe:${item.recipeId}`)
      if (item.productId) taken.add(`product:${item.productId}`)
    }
    return targets.filter((target) => !taken.has(`${target.kind}:${target.id}`))
  }, [targets, items])

  const rows = React.useMemo<WorksheetRow[]>(
    () => items.map((item, index) => ({ item, derived: derived[index] })),
    [items, derived]
  )
  const sorted = sortRows<WorksheetRow, SortKey>(rows, sort, {
    name: (row) => row.item.name,
    category: (row) => row.item.category,
    foodCost: (row) => row.item.foodCostCents ?? -1,
    price: (row) => row.item.sellPriceCents,
    qty: (row) => row.item.qtySold,
    foodCostPercent: (row) => row.derived.foodCostPercent ?? -1,
    margin: (row) => row.derived.marginCents ?? -1,
    revenue: (row) => row.derived.revenueCents,
    profit: (row) => row.derived.grossProfitCents ?? -1,
    shareOfSales: (row) => row.derived.percentOfSales ?? -1,
    menuMix: (row) => row.derived.menuMix ?? -1,
    class: (row) =>
      row.derived.class ? MENU_CLASS_LABELS[row.derived.class] : "",
  })

  const selectedRows = sorted.filter((row) => selected.has(row.item.key))
  const allSelected = sorted.length > 0 && selectedRows.length === sorted.length

  const columnCount = 5 + HIDEABLE.filter((column) => shown(column.id)).length
  // The name stays put while the rest scrolls; its hairline only shows once
  // the table has actually scrolled.
  const [scrolled, setScrolled] = React.useState(false)
  const pinnedName = cn(
    "sticky left-[36px] z-[1] bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:content-['']",
    scrolled ? "after:bg-border" : "after:bg-transparent"
  )

  return (
    <div>
      {/* Over the frame, not inside it: the bar must not pan with the columns. */}
      <div className="relative">
        {selectedRows.length > 0 ? (
          <div className="absolute inset-x-0 top-0 z-10 flex h-[49px] items-center gap-2.5 border-b border-border bg-card pr-0.5 pl-3.5">
            <Checkbox
              checked={allSelected}
              indeterminate={!allSelected}
              onCheckedChange={(checked) =>
                setSelected(
                  checked === true
                    ? new Set(sorted.map((row) => row.item.key))
                    : new Set()
                )
              }
              aria-label="Select all rows"
            />
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    className="h-[30px] gap-1.5 rounded-lg px-[9px] text-foreground tabular-nums"
                  >
                    {selectedRows.length} selected
                    <ChevronDown
                      className="size-[13px]"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </Button>
                }
              />
              <MenuContent align="start" className="w-[176px]">
                {!allSelected ? (
                  <MenuItem
                    onClick={() =>
                      setSelected(new Set(sorted.map((row) => row.item.key)))
                    }
                  >
                    <Check strokeWidth={1.8} aria-hidden="true" />
                    Select all
                  </MenuItem>
                ) : null}
                <MenuItem onClick={() => setSelected(new Set())}>
                  <X strokeWidth={1.8} aria-hidden="true" />
                  Unselect all
                </MenuItem>
              </MenuContent>
            </Menu>
            <BulkDeleteMenu
              count={selectedRows.length}
              noun="item"
              description="They leave this worksheet; the recipes and products themselves stay."
              refreshAfterDelete={false}
              onDelete={() => {
                for (const row of selectedRows) onRemove(row.item.key)
                setSelected(new Set())
                return Promise.resolve()
              }}
            >
              {selectedRows.some(
                (row) =>
                  row.item.sourceSellPriceCents !== null &&
                  row.item.sourceSellPriceCents !== row.item.sellPriceCents
              ) ? (
                <MenuItem
                  onClick={() => {
                    for (const row of selectedRows) {
                      const source = row.item.sourceSellPriceCents
                      if (source !== null)
                        onPatch(row.item.key, { sellPriceCents: source })
                    }
                    setSelected(new Set())
                  }}
                >
                  <CircleDollarSign strokeWidth={1.8} aria-hidden="true" />
                  Use source prices
                </MenuItem>
              ) : null}
            </BulkDeleteMenu>
          </div>
        ) : null}
        <TableFrame
          className="overflow-x-auto"
          onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 0)}
        >
          <Table className="min-w-[1016px]">
            <TableHeader>
              <TableHeaderRow>
                <TableHead className="sticky left-0 z-[1] w-[36px] bg-card pl-3">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={selectedRows.length > 0 && !allSelected}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked === true
                          ? new Set(sorted.map((row) => row.item.key))
                          : new Set()
                      )
                    }
                    aria-label="Select every row"
                  />
                </TableHead>
                <TableHead className={cn("w-[160px] md:w-[220px]", pinnedName)}>
                  <SortHeader
                    direction={directionFor("name")}
                    onClick={() => toggle("name")}
                  >
                    Item
                  </SortHeader>
                </TableHead>
                {shown("category") ? (
                  <TableHead className="w-[140px]">
                    <SortHeader
                      direction={directionFor("category")}
                      onClick={() => toggle("category")}
                    >
                      Category
                    </SortHeader>
                  </TableHead>
                ) : null}
                {shown("foodCost") ? (
                  <TableHead className="w-[90px]">
                    <SortHeader
                      align="right"
                      direction={directionFor("foodCost")}
                      onClick={() => toggle("foodCost")}
                    >
                      Food cost
                    </SortHeader>
                  </TableHead>
                ) : null}
                <TableHead className="w-[110px]">
                  <SortHeader
                    align="right"
                    direction={directionFor("price")}
                    onClick={() => toggle("price")}
                  >
                    Sell price
                  </SortHeader>
                </TableHead>
                <TableHead className="w-[90px]">
                  <SortHeader
                    align="right"
                    direction={directionFor("qty")}
                    onClick={() => toggle("qty")}
                  >
                    Qty sold
                  </SortHeader>
                </TableHead>
                {shown("foodCostPercent") ? (
                  <TableHead className="w-[80px]">
                    <SortHeader
                      align="right"
                      direction={directionFor("foodCostPercent")}
                      onClick={() => toggle("foodCostPercent")}
                    >
                      Food cost %
                    </SortHeader>
                  </TableHead>
                ) : null}
                {shown("margin") ? (
                  <TableHead className="w-[90px]">
                    <SortHeader
                      align="right"
                      direction={directionFor("margin")}
                      onClick={() => toggle("margin")}
                    >
                      Margin
                    </SortHeader>
                  </TableHead>
                ) : null}
                {shown("revenue") ? (
                  <TableHead className="w-[100px]">
                    <SortHeader
                      align="right"
                      direction={directionFor("revenue")}
                      onClick={() => toggle("revenue")}
                    >
                      Revenue
                    </SortHeader>
                  </TableHead>
                ) : null}
                {shown("profit") ? (
                  <TableHead className="w-[110px]">
                    <SortHeader
                      align="right"
                      direction={directionFor("profit")}
                      onClick={() => toggle("profit")}
                    >
                      Gross profit
                    </SortHeader>
                  </TableHead>
                ) : null}
                {shown("shareOfSales") ? (
                  <TableHead className="w-[90px]">
                    <SortHeader
                      align="right"
                      direction={directionFor("shareOfSales")}
                      onClick={() => toggle("shareOfSales")}
                    >
                      % of sales
                    </SortHeader>
                  </TableHead>
                ) : null}
                {shown("menuMix") ? (
                  <TableHead className="w-[90px]">
                    <SortHeader
                      align="right"
                      direction={directionFor("menuMix")}
                      onClick={() => toggle("menuMix")}
                    >
                      Menu mix %
                    </SortHeader>
                  </TableHead>
                ) : null}
                {shown("class") ? (
                  <TableHead className="w-[100px]">
                    <SortHeader
                      direction={directionFor("class")}
                      onClick={() => toggle("class")}
                    >
                      Class
                    </SortHeader>
                  </TableHead>
                ) : null}
                <TableHead className="w-[92px]">
                  <div className="flex justify-end">
                    <ColumnsMenu
                      columns={HIDEABLE.map((column) => ({
                        id: column.id,
                        label: column.label,
                        visible: shown(column.id),
                        onToggle: (visible: boolean) =>
                          toggleColumn(column.id, visible),
                      }))}
                    />
                  </div>
                </TableHead>
              </TableHeaderRow>
            </TableHeader>
            <TableBody>
              {sorted.length === 0 ? (
                <TableRow className="h-11 hover:!bg-transparent">
                  <TableCell
                    colSpan={columnCount}
                    className="pl-3 text-base text-muted-foreground"
                  >
                    No items yet.
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map(({ item, derived: row }) => {
                  const linked =
                    item.recipeId !== null || item.productId !== null
                  const kind = item.recipeId ? "recipe" : "product"
                  const source = item.sourceSellPriceCents
                  const priceAlert = !linked
                    ? null
                    : item.sourceSellPriceCents === null
                      ? `No price on the ${kind}`
                      : item.sourceSellPriceCents !== item.sellPriceCents
                        ? `${item.recipeId ? "Recipe" : "Product"} price is ${formatCents(item.sourceSellPriceCents, currencyCode)}`
                        : null
                  return (
                    <TableRow
                      key={item.key}
                      className="group/row h-11 hover:!bg-transparent"
                    >
                      <TableCell className="sticky left-0 z-[1] w-[36px] bg-card pl-3">
                        <Checkbox
                          checked={selected.has(item.key)}
                          onCheckedChange={(checked) =>
                            setSelected((current) => {
                              const next = new Set(current)
                              if (checked === true) next.add(item.key)
                              else next.delete(item.key)
                              return next
                            })
                          }
                          aria-label={`Select ${item.name || "row"}`}
                        />
                      </TableCell>
                      <TableCell
                        className={cn("w-[160px] md:w-[220px]", pinnedName)}
                      >
                        {linked ? (
                          <span className="flex min-w-0 items-center gap-2">
                            <GuardedLink
                              href={
                                item.recipePublicId
                                  ? `/recipes/${encodeURIComponent(item.recipePublicId)}/recipe`
                                  : productHref({
                                      publicId: item.productPublicId ?? "",
                                    })
                              }
                              className="truncate rounded-sm text-base text-foreground outline-none hover:underline focus-visible:underline"
                            >
                              {item.name}
                            </GuardedLink>
                            <Badge size="row" variant="secondary">
                              {item.recipeId ? "Recipe" : "Product"}
                            </Badge>
                          </span>
                        ) : (
                          <ItemNameCell
                            item={item}
                            autoFocus={item.key === focusKey}
                            targets={openTargets}
                            onPatch={onPatch}
                            onPick={(target) => onLinkTarget(item.key, target)}
                            onCreateRecipe={(name) =>
                              onCreateRecipe(item.key, name)
                            }
                            onCreateProduct={(name) =>
                              onCreateProduct(item.key, name)
                            }
                          />
                        )}
                      </TableCell>
                      {shown("category") ? (
                        <TableCell className="w-[140px] text-base text-muted-foreground">
                          {item.category || "—"}
                        </TableCell>
                      ) : null}
                      {shown("foodCost") ? (
                        <TableCell className={cn("w-[90px]", numberCell)}>
                          {item.foodCostCents === null && linked ? (
                            <span className="flex items-center justify-end gap-0.5">
                              <AlertFlag label="Not costed yet" />
                              <span>—</span>
                            </span>
                          ) : (
                            money(item.foodCostCents, currencyCode)
                          )}
                        </TableCell>
                      ) : null}
                      <TableCell className="w-[110px]">
                        <span className="flex items-center justify-end gap-0.5">
                          {priceAlert ? (
                            <AlertFlag
                              label={priceAlert}
                              width={172}
                              actions={
                                source === null
                                  ? undefined
                                  : [
                                      {
                                        label: `Use ${formatCents(source, currencyCode)}`,
                                        onClick: () =>
                                          onPatch(item.key, {
                                            sellPriceCents: source,
                                          }),
                                      },
                                    ]
                              }
                            />
                          ) : null}
                          <PriceCell item={item} onPatch={onPatch} />
                        </span>
                      </TableCell>
                      <TableCell className="w-[90px]">
                        {item.productId ? (
                          <span className="block text-right text-base text-muted-foreground tabular-nums">
                            {item.qtySold > 0
                              ? quantityFormat.format(item.qtySold)
                              : "—"}
                          </span>
                        ) : (
                          <QtyCell item={item} onPatch={onPatch} />
                        )}
                      </TableCell>
                      {shown("foodCostPercent") ? (
                        <TableCell className={cn("w-[80px]", numberCell)}>
                          {percent(row.foodCostPercent)}
                        </TableCell>
                      ) : null}
                      {shown("margin") ? (
                        <TableCell className={cn("w-[90px]", numberCell)}>
                          {money(row.marginCents, currencyCode)}
                        </TableCell>
                      ) : null}
                      {shown("revenue") ? (
                        <TableCell className={cn("w-[100px]", numberCell)}>
                          {formatCents(row.revenueCents, currencyCode)}
                        </TableCell>
                      ) : null}
                      {shown("profit") ? (
                        <TableCell className={cn("w-[110px]", numberCell)}>
                          {money(row.grossProfitCents, currencyCode)}
                        </TableCell>
                      ) : null}
                      {shown("shareOfSales") ? (
                        <TableCell className={cn("w-[90px]", numberCell)}>
                          {percent(row.percentOfSales)}
                        </TableCell>
                      ) : null}
                      {shown("menuMix") ? (
                        <TableCell className={cn("w-[90px]", numberCell)}>
                          {percent(row.menuMix)}
                        </TableCell>
                      ) : null}
                      {shown("class") ? (
                        <TableCell className="w-[100px] text-base text-muted-foreground">
                          {row.class ? MENU_CLASS_LABELS[row.class] : "—"}
                        </TableCell>
                      ) : null}
                      <TableCell className="w-[92px]">
                        <div className="flex items-center justify-end gap-0.5">
                          <RowActionsMenu
                            label={`Actions for ${item.name || "row"}`}
                          >
                            {linked ? (
                              <MenuItem
                                onClick={() => {
                                  // Back to the picker; the price and quantity
                                  // typed on the row stay.
                                  onPatch(item.key, {
                                    recipeId: null,
                                    recipePublicId: null,
                                    productId: null,
                                    productPublicId: null,
                                    category: "",
                                    foodCostCents: null,
                                    sourceSellPriceCents: null,
                                    sourceQtySold: null,
                                  })
                                  setFocusKey(item.key)
                                }}
                              >
                                <SquarePen
                                  strokeWidth={1.8}
                                  aria-hidden="true"
                                />
                                Change link
                              </MenuItem>
                            ) : null}
                            <MenuItem
                              onClick={() => onRemove(item.key)}
                              className="text-destructive data-highlighted:text-destructive"
                            >
                              <Trash2
                                className="text-current"
                                strokeWidth={1.8}
                                aria-hidden="true"
                              />
                              Remove
                            </MenuItem>
                          </RowActionsMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </TableFrame>
      </div>

      <QuickAdd
        targets={openTargets}
        onAddNamed={(name) => onAdd({ name })}
        onPick={(target) => onLinkTarget(onAdd(), target)}
        onCreateRecipe={(name) => onCreateRecipe(onAdd({ name }), name)}
        onCreateProduct={(name) => onCreateProduct(onAdd({ name }), name)}
      />
      <AddButton className="mt-2" onClick={() => setFocusKey(onAdd())} />
    </div>
  )
}
