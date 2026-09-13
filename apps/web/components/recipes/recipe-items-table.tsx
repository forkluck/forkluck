"use client"

import * as React from "react"
import {
  Anchor,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GripVertical,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react"

import {
  activateCatalogIngredient,
  saveIngredient,
  searchCatalogIngredients,
} from "@/app/(app)/ingredients/actions"
import { saveRecipe } from "@/app/(app)/recipes/actions"
import {
  dragHandleClassName,
  useSortableRows,
} from "@/components/recipes/use-sortable-rows"
import { AddButton } from "@/components/ui/add-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ColumnsMenu } from "@/components/ui/columns-menu"
import { Input } from "@/components/ui/input"
import {
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu"
import {
  displayUnitShort,
  inlineChipClassName,
} from "@/components/ingredients/unit-combobox"
import { RowActionsMenu } from "@/components/ui/row-actions"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Select,
  SelectContent,
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
import { matchPreparation, normalizeIngredientName } from "@/lib/pricing"
import {
  clampRecipeQuantity,
  formatKitchenAmount,
  parseRecipeAmount,
  parseRecipeText,
  tidyVolume,
  type ParsedRecipeLine,
} from "@/lib/recipe"
import { resolveLine, withPreparationNote } from "@/lib/recipe/resolve-line"
import { splitRecipeDocument } from "@/lib/recipe/split-document"
import { fuzzyMatches } from "@/lib/fuzzy"
import { KNOWN_UNITS, convertAmount, countedAsEach } from "@/lib/unit-registry"
import { UnitOptions } from "@/components/recipes/unit-options"
import { useToast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import { useHydrated } from "@/hooks/use-hydrated"

export type RecipeItemKind = "header" | "note" | "ingredient" | "subrecipe"

/** One line of a linked recipe, as the parent row shows it. */
export type SubrecipeLine = {
  kind: RecipeItemKind
  quantity: number | null
  unit: string
  displayName: string
  preparationNote: string
  subrecipeId: string | null
}

/**
 * The linked recipe a sub-recipe row expands into. One level deep: a nested
 * line names its own sub-recipe but carries no lines of its own.
 */
export type Subrecipe = {
  id: string
  publicId: string
  title: string
  yieldAmount: number | null
  yieldUnit: string | null
  items: SubrecipeLine[]
}

export type RecipeItemState = {
  key: string
  kind: RecipeItemKind
  displayName: string
  quantity: string
  unit: string
  preparationNote: string
  efficiency: string
  efficiencyAfterCooking: string
  /** The line baker's percentages are stated against. */
  isBase: boolean
  /** Kept in the recipe but not in its cost: garnish, a line priced elsewhere. */
  excludedFromCost: boolean
  ingredientId: string | null
  subrecipeId: string | null
  /** The linked recipe's public id, which is what its URL is written with. */
  subrecipePublicId?: string | null
  /** The linked recipe, once the line has been saved. */
  subrecipe?: Subrecipe | null
}

export type RecipeItemsTableProps = {
  items: RecipeItemState[]
  canEdit: boolean
  recipeId: string | null
  ingredientTargets: Target[]
  recipeTargets: { id: string; publicId?: string; title: string }[]
  /** A catalog pick lands in the pantry: later rows must see it without a reload. */
  onIngredientActivated: (row: Target) => void
  onPatch: (key: string, patch: Partial<RecipeItemState>) => void
  /** Opens the paste dialog: a whole list at once. */
  onOpenImport: () => void
  /**
   * Takes the method half of a pasted recipe and adds it as steps. Without it
   * a paste stays on this table, method lines and all.
   */
  onAddSteps?: (text: string) => void
  /** The batch being viewed: quantities display multiplied, 1 is as written. */
  scale?: number
  invalidKey?: string | null
  onReorder: (fromIndex: number, toIndex: number) => void
  onRemove: (key: string) => void
  /** Adds a row after `afterKey` (the row last touched), or last; returns its key. */
  onAdd: (
    kind: RecipeItemKind,
    partial?: Partial<RecipeItemState>,
    afterKey?: string | null
  ) => string
  percentMode: boolean
  onPercentModeChange: (next: boolean) => void
  /** "standard" is each line of the whole; "bakers" is each line of the base. */
  percentageMode: string
  onPercentageModeChange: (next: string) => void
  onSetBase: (key: string) => void
  /**
   * Row key to the reason that row cannot be weighed, while the editor is
   * auto-calculating the yield. Empty the rest of the time.
   */
  weighAlerts?: Record<string, string>
}

const cellInput =
  "h-8 rounded-md border-transparent bg-transparent px-2 text-base md:text-base enabled:not-focus:hover:border-transparent disabled:border-transparent disabled:bg-transparent"

function isMeasured(kind: RecipeItemKind) {
  return kind === "ingredient" || kind === "subrecipe"
}

/** A resting row reads in kitchen fractions; the cook types whatever they like. */
function restingQuantity(quantity: string): string {
  const trimmed = quantity.trim()
  if (!trimmed) return ""
  const amount = Number(trimmed)
  return Number.isFinite(amount) ? formatKitchenAmount(amount) : trimmed
}

/**
 * What a line shows at the batch being viewed: its own quantity and unit at
 * 1x, otherwise the scaled amount in the unit a cook would measure it with.
 */
function shownMeasure(
  item: RecipeItemState,
  scale: number
): { amount: string; unit: string } {
  if (scale === 1 || !item.quantity) {
    return { amount: item.quantity, unit: item.unit }
  }
  const tidy = tidyVolume(Number(item.quantity) * scale, item.unit)
  return { amount: clampRecipeQuantity(tidy.amount), unit: tidy.unit }
}

function QuantityCell({
  item,
  canEdit,
  scale,
  onPatch,
  weighAlert = null,
}: {
  item: RecipeItemState
  canEdit: boolean
  scale: number
  onPatch: (key: string, patch: Partial<RecipeItemState>) => void
  /** Why this line holds the auto-calculated yield back, when it does. */
  weighAlert?: string | null
}) {
  // Null while the row rests, so the cell shows "1/4" until it is being typed in.
  const [draft, setDraft] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const field = (
    <Input
      ref={inputRef}
      className={cn(
        cellInput,
        "tabular-nums",
        weighAlert &&
          "border-warning-border pr-6 focus-visible:border-warning enabled:not-focus:hover:border-warning-border"
      )}
      type="text"
      inputMode="decimal"
      value={draft ?? restingQuantity(shownMeasure(item, scale).amount)}
      disabled={!canEdit}
      aria-label="Quantity"
      onFocus={() => setDraft(shownMeasure(item, scale).amount)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === null) return
        const text = draft.trim()
        setDraft(null)
        // Blank is a real answer: an unmeasured row carries no quantity.
        if (!text) {
          onPatch(item.key, { quantity: "" })
          return
        }
        const amount = parseRecipeAmount(text)
        if (amount === null) return
        // What was typed is the amount at this batch, in the unit shown; the
        // recipe keeps the 1x amount in its own unit.
        const shown = shownMeasure(item, scale)
        const base =
          (convertAmount(amount, shown.unit, item.unit) ?? amount) / scale
        onPatch(item.key, { quantity: clampRecipeQuantity(base) })
      }}
    />
  )

  if (!weighAlert) return field
  // The same amber edge and triangle an unlinked name wears, for the same
  // reason: the fix is this row, so the warning sits on the row.
  return (
    <div className="relative">
      {field}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={weighAlert}
              className="absolute top-1/2 right-0.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-warning outline-none hover:bg-warning-fill focus-visible:bg-warning-fill"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => inputRef.current?.focus()}
            />
          }
        >
          <TriangleAlert
            className="size-[13px]"
            strokeWidth={1.9}
            aria-hidden="true"
          />
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px]">{weighAlert}</TooltipContent>
      </Tooltip>
    </div>
  )
}

const NO_RECIPES: { id: string; title: string }[] = []

export const PERCENT_MODE_KEY = "recipe.percentageMode"
const NOTES_COLUMN_KEY = "recipe.items.notes"

/** A markdown heading: "# Filling" makes a section row. */
export const HEADING_PATTERN = /^#{1,6}\s*(.+)$/
/** A markdown quote, or "Note:" as recipes write it, makes a note row. */
export const NOTE_PATTERN = /^(?:>\s*|(?:notes?|tips?):\s*)(.+)$/i
/** Every break a copied list arrives with: a PDF writes U+2028, Excel a lone \r. */
const LINE_BREAK = /[\r\n\u2028\u2029]/

type Target = {
  id: string
  name: string
  preparations?: string[]
  /** Absent where the caller has no status to give; archived rows are skipped. */
  status?: "active" | "archived"
  /** A supply is packaging, never a recipe line; absent means food. */
  nonEdible?: boolean
}

/**
 * The note clause naming one of the linked ingredient's own preparations, and
 * what the note says besides it. The field then reads "Egg, whole" while the
 * note keeps the clause weighing and costing match on.
 */
function splitPreparationNote(
  item: RecipeItemState,
  ingredientTargets: Target[]
): { preparation: string | null; rest: string } {
  const note = item.preparationNote
  const linked = item.ingredientId
    ? ingredientTargets.find((one) => one.id === item.ingredientId)
    : undefined
  const matched = matchPreparation(
    { preparations: (linked?.preparations ?? []).map((name) => ({ name })) },
    note
  )
  if (!matched) return { preparation: null, rest: note }
  const clauses = note.split(/[,;]/).map((clause) => clause.trim())
  const at = clauses.findIndex(
    (clause) =>
      normalizeIngredientName(clause) === normalizeIngredientName(matched.name)
  )
  return {
    preparation: clauses[at],
    rest: clauses
      .filter((clause, index) => index !== at && clause !== "")
      .join(", "),
  }
}

/** The note a composed field writes back: the preparation, then the rest. */
function joinPreparationNote(preparation: string | null, rest: string): string {
  if (!preparation) return rest
  return rest.trim() ? `${preparation}, ${rest}` : preparation
}

/**
 * "Almond, sliced" typed out in full: an ingredient and one of its own
 * preparations, which is an attachment rather than free text. Exact only, so
 * nothing is guessed on the way out of the field.
 */
function composedTarget(
  typed: string,
  ingredientTargets: Target[]
): { target: Target; preparation: string } | null {
  const wanted = normalizeIngredientName(typed)
  if (!wanted) return null
  for (const target of ingredientTargets) {
    // An archived ingredient or a supply answers no new line, typed or picked.
    if (target.status === "archived" || target.nonEdible) continue
    for (const preparation of target.preparations ?? []) {
      if (normalizeIngredientName(`${target.name} ${preparation}`) === wanted) {
        return { target, preparation }
      }
    }
  }
  return null
}

type SuggestionRow = {
  kind: "ingredient" | "recipe" | "catalog"
  id: string
  /** The ingredient or recipe the row stands for. */
  name: string
  /** Set on a child row: one of its preparations. */
  preparation: string | null
  /** The synonym the typing matched, when it is not the name itself. */
  alias?: string | null
  /** Set on a recipe row: the public id its URL is written with. */
  publicId?: string | null
}

function withChildren(
  kind: "ingredient" | "catalog",
  id: string,
  name: string,
  preparations: string[] | undefined,
  children: boolean,
  alias: string | null = null
): SuggestionRow[] {
  const parent = { kind, id, name, preparation: null, alias }
  if (!children) return [parent]
  return [
    parent,
    ...(preparations ?? []).map((preparation) => ({
      kind,
      id,
      name,
      preparation,
    })),
  ]
}

/**
 * Why a card the cook did not name is on the list: the synonym their word
 * matched. A synonym that reads as the name itself explains nothing, so it
 * stays off the row.
 */
function matchedAlias(
  aliases: string[] | undefined,
  needle: string
): string | null {
  const wanted = normalizeIngredientName(needle)
  return (
    (aliases ?? []).find(
      (alias) =>
        normalizeIngredientName(alias) !== "" &&
        fuzzyMatches(normalizeIngredientName(alias), wanted)
    ) ?? null
  )
}

/**
 * What the cook already owns, then catalog cards to pull in. The catalog is
 * only asked once the pantry runs short of answers, and only after typing
 * settles, so a dropdown does not fire a request per keystroke. A line that
 * already sits in the table lists each ingredient's preparations under it;
 * the quick-add names the ingredient only.
 */
function useIngredientSuggestions(
  text: string,
  ingredientTargets: Target[],
  recipeTargets: { id: string; publicId?: string; title: string }[],
  currentId: string | null = null,
  children = true
): SuggestionRow[] {
  const needle = text.trim().toLocaleLowerCase()

  const owned = React.useMemo(() => {
    const matches = (name: string) =>
      !needle ||
      fuzzyMatches(
        normalizeIngredientName(name),
        normalizeIngredientName(needle)
      )
    // A row named in full — "almond, sliced" — reaches the preparation it
    // names, so typing it finds the child the pick attaches.
    const nested = (row: { name: string; preparations?: string[] }) =>
      matches(row.name)
        ? (row.preparations ?? [])
        : (row.preparations ?? []).filter((one) =>
            matches(`${row.name}, ${one}`)
          )
    const parents = [
      // An archived ingredient, or a supply, stays on the line that already
      // points at it, but neither is something to reach for on a new one.
      ...ingredientTargets
        .filter(
          (one) =>
            (one.status !== "archived" && !one.nonEdible) ||
            one.id === currentId
        )
        .map((one) => ({ ...one, recipe: false })),
      ...recipeTargets.map((one) => ({
        id: one.id,
        publicId: one.publicId ?? null,
        name: one.title,
        preparations: undefined,
        recipe: true,
      })),
    ]
    return (
      parents
        .filter((row) => matches(row.name) || nested(row).length > 0)
        // The line's own ingredient leads: focusing a filled field reopens the
        // list on its name, and the first row should be what is already there.
        .sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId))
        .slice(0, 20)
        .flatMap((row) =>
          row.recipe
            ? [
                {
                  kind: "recipe" as const,
                  id: row.id,
                  publicId: "publicId" in row ? row.publicId : null,
                  name: row.name,
                  preparation: null,
                },
              ]
            : withChildren(
                "ingredient",
                row.id,
                row.name,
                nested(row),
                children
              )
        )
    )
  }, [ingredientTargets, recipeTargets, needle, currentId, children])

  const wanted =
    needle.length >= 2 && owned.filter((row) => !row.preparation).length < 8
  // Results belong to the needle that fetched them, so an older response
  // cannot replace the suggestions for what the cook is typing now.
  const [catalog, setCatalog] = React.useState<{
    needle: string
    rows: SuggestionRow[]
  }>({ needle: "", rows: [] })

  React.useEffect(() => {
    if (!wanted) return
    let live = true
    const timer = setTimeout(() => {
      void searchCatalogIngredients(needle).then((result) => {
        if (!live) return
        setCatalog({
          needle,
          rows:
            "error" in result
              ? []
              : result.items.flatMap((one) =>
                  withChildren(
                    "catalog",
                    one.id,
                    one.name,
                    one.preparations,
                    children,
                    fuzzyMatches(
                      normalizeIngredientName(one.name),
                      normalizeIngredientName(needle)
                    )
                      ? null
                      : matchedAlias(one.aliases, needle)
                  )
                ),
        })
      })
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [needle, wanted, children])

  const answered = catalog.needle === needle
  return wanted && answered ? [...owned, ...catalog.rows] : owned
}

/** ArrowUp/ArrowDown wrap the list, Escape drops the highlight. True when the
 * key belonged to the list rather than the field. */
function navigateSuggestions(
  event: React.KeyboardEvent,
  count: number,
  setHighlighted: React.Dispatch<React.SetStateAction<number>>
) {
  if (event.key === "ArrowDown" && count > 0) {
    event.preventDefault()
    setHighlighted((index) => (index >= count - 1 ? 0 : index + 1))
    return true
  }
  if (event.key === "ArrowUp" && count > 0) {
    event.preventDefault()
    setHighlighted((index) => (index <= 0 ? count - 1 : index - 1))
    return true
  }
  if (event.key === "Escape") {
    setHighlighted(-1)
    return true
  }
  return false
}

/** Picking a catalog card copies it into the pantry first; the line then points
 * at that new pantry row. Null when the copy failed and nothing should change.
 * `note` is what the line already says, which a pick adds to and never erases. */
async function pickSuggestion(
  row: SuggestionRow,
  note: string
): Promise<{
  patch: Partial<RecipeItemState>
  activated: Target | null
} | null> {
  if (row.kind !== "catalog") {
    const recipe = row.kind === "recipe"
    return {
      patch: {
        kind: recipe ? "subrecipe" : "ingredient",
        ingredientId: recipe ? null : row.id,
        subrecipeId: recipe ? row.id : null,
        subrecipePublicId: recipe ? (row.publicId ?? null) : null,
        // The nested lines arrive with the next read, not with the pick.
        subrecipe: null,
        displayName: row.name,
        preparationNote: withPreparationNote(note, row.preparation),
      },
      activated: null,
    }
  }
  const result = await activateCatalogIngredient(row.id)
  if ("error" in result) return null
  return {
    patch: {
      kind: "ingredient",
      ingredientId: result.id,
      subrecipeId: null,
      subrecipePublicId: null,
      subrecipe: null,
      displayName: result.name,
      preparationNote: withPreparationNote(note, row.preparation),
    },
    activated: {
      id: result.id,
      name: result.name,
      preparations: result.preparations,
    },
  }
}

/**
 * What a typed name becomes when nothing matches it: a pantry ingredient
 * with no price yet, or an empty component recipe to write up later. Either
 * way the line links to it at once.
 */
type CreateKind = "ingredient" | "recipe"

async function createTarget(
  kind: CreateKind,
  name: string
): Promise<
  | { patch: Partial<RecipeItemState>; activated: Target | null }
  | { error: string }
  | null
> {
  if (kind === "recipe") {
    const result = await saveRecipe({
      id: null,
      title: name,
      kind: "component",
    })
    if ("error" in result) return result
    return {
      patch: {
        kind: "subrecipe",
        ingredientId: null,
        subrecipeId: result.id,
        subrecipePublicId: result.publicId,
        subrecipe: null,
        displayName: name,
      },
      activated: null,
    }
  }
  const result = await saveIngredient({
    id: null,
    name,
    purchaseCostCents: 0,
    purchaseSize: null,
    purchaseUnit: null,
  })
  if ("error" in result) return null
  return {
    patch: {
      kind: "ingredient",
      ingredientId: result.id,
      subrecipeId: null,
      subrecipePublicId: null,
      subrecipe: null,
      displayName: name,
    },
    activated: { id: result.id, name, preparations: [] },
  }
}

function IngredientSuggestions({
  rows,
  text,
  highlighted,
  selectedId,
  onPick,
  onCreate,
}: {
  rows: SuggestionRow[]
  text: string
  highlighted: number
  selectedId: string | null
  onPick: (row: SuggestionRow) => void
  /** Offered under the matches; the quick-add keeps to what exists. */
  onCreate?: (kind: CreateKind, name: string) => void
}) {
  const typed = text.trim()
  // Nothing to add when the cook already has a row by this name; a catalog
  // card of the same name is not theirs yet, so the footer stays.
  const exact = rows.some(
    (row) =>
      row.kind !== "catalog" &&
      normalizeIngredientName(
        row.preparation === null ? row.name : `${row.name} ${row.preparation}`
      ) === normalizeIngredientName(typed)
  )
  const footerClassName =
    "flex h-9 w-full items-center rounded-md px-2.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
  return (
    <div
      role="listbox"
      className="absolute top-full right-0 z-40 mt-1 max-h-60 w-[min(18rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-popover-border bg-popover p-1.5 text-popover-foreground sm:left-0 sm:w-auto"
    >
      {rows.map((row, index) => (
        <button
          key={`${row.kind}:${row.id}:${row.preparation ?? ""}`}
          type="button"
          role="option"
          aria-selected={row.id === selectedId && row.preparation === null}
          aria-label={
            row.preparation === null
              ? undefined
              : `${row.name}, ${row.preparation}`
          }
          data-highlighted={index === highlighted || undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(row)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent",
            // A preparation is a quiet sub-row under its ingredient.
            row.preparation === null
              ? "h-9 text-sm"
              : "h-7 pl-7 text-xs text-muted-foreground",
            index === highlighted && "bg-accent"
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {row.preparation ?? row.name}
            {row.preparation === null && row.alias ? (
              <span className="ml-2 text-muted-foreground">{row.alias}</span>
            ) : null}
          </span>
          {row.preparation === null && row.kind === "recipe" ? (
            <Badge variant="secondary">Recipe</Badge>
          ) : null}
          {row.preparation === null && row.kind === "catalog" ? (
            <Badge variant="secondary">Catalog</Badge>
          ) : null}
        </button>
      ))}
      {onCreate && typed.length >= 2 && !exact ? (
        <>
          <button
            type="button"
            className={footerClassName}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCreate("ingredient", typed)}
          >
            Add ingredient
          </button>
          <button
            type="button"
            className={footerClassName}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCreate("recipe", typed)}
          >
            Add recipe
          </button>
        </>
      ) : null}
    </div>
  )
}

/**
 * How many of the child's batches this line asks for: the line's amount in
 * the child's yield unit, over the child's yield. Null when the two units do
 * not relate, or the child has no yield to divide by: the panel then says so
 * and shows the recipe as written.
 */
function batchFactor(
  amount: string,
  unit: string,
  child: Subrecipe
): number | null {
  const quantity = Number(amount)
  if (!Number.isFinite(quantity) || quantity <= 0) return null
  if (!child.yieldAmount) return null
  // A yield counted in pieces or slices is asked for in "each": the same
  // count either way, so 1 slice of an 8 slice tart is an eighth of a batch.
  const inYieldUnit = convertAmount(
    quantity,
    countedAsEach(unit) ?? unit,
    countedAsEach(child.yieldUnit)
  )
  if (inYieldUnit === null) return null
  return inYieldUnit / child.yieldAmount
}

/** A multiplier reads as a number: "1x", "0.5x", never "1/2x". */
function formatFactor(factor: number): string {
  const shown = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(factor)
  return `${shown}x`
}

/** A child's line at the batch shown, in the fractions the table uses. */
function nestedMeasure(
  line: SubrecipeLine,
  factor: number
): { amount: string; unit: string } {
  if (line.quantity === null) return { amount: "", unit: line.unit }
  if (factor === 1) {
    return { amount: restingQuantity(String(line.quantity)), unit: line.unit }
  }
  const tidy = tidyVolume(line.quantity * factor, line.unit)
  return {
    amount: restingQuantity(clampRecipeQuantity(tidy.amount)),
    unit: tidy.unit,
  }
}

/** The linked recipe opened in place, under the line that calls for it. */
function SubrecipePanel({
  child,
  amount,
  unit,
  columns,
}: {
  child: Subrecipe
  /** The parent line's amount and unit at the batch being viewed. */
  amount: string
  unit: string
  columns: number
}) {
  const factor = batchFactor(amount, unit, child)
  const shownFactor = factor ?? 1
  const childYield =
    child.yieldAmount === null
      ? "Not set"
      : `${formatKitchenAmount(child.yieldAmount * shownFactor)} ${displayUnitShort(child.yieldUnit)}`.trim()

  return (
    <TableRow className="hover:!bg-transparent">
      <TableCell className="w-6 pl-1 sm:w-8 sm:pl-3" />
      <TableCell colSpan={columns - 1} className="pb-3">
        <div className="rounded-md border border-muted bg-fill-soft px-3 py-2.5 text-sm break-words">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-medium">Sub-recipe</span>
            <span className="text-muted-foreground">
              Batch size{" "}
              <span className="text-foreground tabular-nums">
                {formatFactor(shownFactor)}
              </span>
            </span>
            <span className="text-muted-foreground">
              Yield{" "}
              <span className="text-foreground tabular-nums">{childYield}</span>
            </span>
            {factor === null ? (
              <span className="text-muted-foreground">Shown at 1x</span>
            ) : null}
          </div>
          <ul className="mt-2 space-y-1">
            {child.items.map((line, index) => {
              if (line.kind === "header") {
                return (
                  <li key={index} className="pt-1 first:pt-0">
                    <h4 className="font-medium text-foreground">
                      {line.displayName}
                    </h4>
                  </li>
                )
              }
              if (line.kind === "note") {
                return (
                  <li key={index} className="text-muted-foreground italic">
                    {line.displayName}
                  </li>
                )
              }
              const measure = nestedMeasure(line, shownFactor)
              return (
                <li
                  key={index}
                  className="flex flex-wrap gap-x-2 text-muted-foreground"
                >
                  {measure.amount ? (
                    <span className="text-foreground tabular-nums">
                      {measure.amount}
                    </span>
                  ) : null}
                  {measure.unit ? (
                    <span>{displayUnitShort(measure.unit)}</span>
                  ) : null}
                  <span className="text-foreground">{line.displayName}</span>
                  {line.preparationNote ? (
                    <span className="italic">{line.preparationNote}</span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          <a
            href={`/recipes/${child.publicId}/recipe`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-muted-foreground underline-offset-2 hover:underline"
          >
            <ExternalLink
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Open sub-recipe for prep method
          </a>
        </div>
      </TableCell>
    </TableRow>
  )
}

/** The note, less the preparation the ingredient field already reads out. */
function NotesCell({
  item,
  canEdit,
  ingredientTargets,
  onPatch,
}: {
  item: RecipeItemState
  canEdit: boolean
  ingredientTargets: Target[]
  onPatch: (key: string, patch: Partial<RecipeItemState>) => void
}) {
  const { preparation, rest } = splitPreparationNote(item, ingredientTargets)
  return (
    <Input
      className={cn(cellInput, rest && "italic")}
      value={rest}
      disabled={!canEdit}
      placeholder="Add notes"
      aria-label="Notes"
      onChange={(event) =>
        onPatch(item.key, {
          preparationNote: joinPreparationNote(preparation, event.target.value),
        })
      }
    />
  )
}

function TargetPicker({
  item,
  canEdit,
  ingredientTargets,
  recipeTargets,
  onPatch,
  onIngredientActivated,
}: {
  item: RecipeItemState
  canEdit: boolean
  ingredientTargets: Target[]
  recipeTargets: { id: string; publicId?: string; title: string }[]
  onPatch: (key: string, patch: Partial<RecipeItemState>) => void
  onIngredientActivated: (row: Target) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState<string | null>(null)
  const [highlighted, setHighlighted] = React.useState(-1)
  const toast = useToast()
  const { preparation } = splitPreparationNote(item, ingredientTargets)
  const composed = preparation
    ? `${item.displayName}, ${preparation}`
    : item.displayName
  const value = query ?? composed
  const rows = useIngredientSuggestions(
    value,
    ingredientTargets,
    recipeTargets,
    item.ingredientId ?? item.subrecipeId
  )

  const apply = (picked: Awaited<ReturnType<typeof pickSuggestion>>) => {
    if (!picked) return
    onPatch(item.key, picked.patch)
    if (picked.activated) onIngredientActivated(picked.activated)
  }
  const pick = async (row: SuggestionRow) => {
    setQuery(null)
    setOpen(false)
    setHighlighted(-1)
    apply(await pickSuggestion(row, item.preparationNote))
  }
  const create = async (kind: CreateKind, name: string) => {
    setQuery(null)
    setOpen(false)
    setHighlighted(-1)
    const created = await createTarget(kind, name)
    if (created && "error" in created) {
      toast.add({ title: created.error, type: "error" })
      return
    }
    apply(created)
  }

  // An unlinked line says so on the field itself: an amber edge and a
  // triangle that explains on hover and opens the picker on click, the
  // fix is the field, so there is no third surface to go through.
  const unlinked = !item.ingredientId && !item.subrecipeId
  const linkedName = item.ingredientId
    ? ingredientTargets.find((one) => one.id === item.ingredientId)?.name
    : recipeTargets.find((one) => one.id === item.subrecipeId)?.title
  // A linked line reading more than its link and a saved preparation do: the
  // extra words are free text, which nothing weighs or costs.
  const strayWords =
    linkedName !== undefined &&
    normalizeIngredientName(item.displayName) !==
      normalizeIngredientName(linkedName)
  const flagged = unlinked || strayWords
  const inputRef = React.useRef<HTMLInputElement>(null)

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        className={cn(
          cellInput,
          flagged &&
            "border-warning-border pr-8 focus-visible:border-warning enabled:not-focus:hover:border-warning-border"
        )}
        value={value}
        disabled={!canEdit}
        placeholder="Search ingredients and recipes"
        role="combobox"
        aria-expanded={open}
        aria-label="Ingredient or recipe"
        onFocus={(event) => {
          // A filled field opens on its own name, selected so typing replaces it.
          if (composed) {
            event.target.select()
            setQuery(composed)
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
          const row = highlighted >= 0 ? rows[highlighted] : null
          if (!row) return
          event.preventDefault()
          void pick(row)
        }}
        onBlur={() => {
          setOpen(false)
          setHighlighted(-1)
          if (query !== null && query !== composed) {
            const named = composedTarget(query, ingredientTargets)
            onPatch(
              item.key,
              named
                ? {
                    kind: "ingredient",
                    ingredientId: named.target.id,
                    subrecipeId: null,
                    subrecipePublicId: null,
                    subrecipe: null,
                    displayName: named.target.name,
                    preparationNote: withPreparationNote(
                      item.preparationNote,
                      named.preparation
                    ),
                  }
                : { displayName: query }
            )
          }
          setQuery(null)
        }}
      />
      {flagged && item.displayName ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={
                  unlinked
                    ? "Not linked: pick an ingredient or recipe"
                    : "Not a saved preparation: pick one from the list"
                }
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
            {unlinked
              ? "Not one of your ingredients or recipes, so it can’t be weighed or costed. Pick one from the list, or keep it as typed."
              : "The extra words aren’t a saved preparation, so they don’t count in weighing or costing. Pick one from the list, or keep it as typed."}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {open && query !== null && query.trim() ? (
        <IngredientSuggestions
          rows={rows}
          text={value}
          highlighted={highlighted}
          selectedId={item.ingredientId ?? item.subrecipeId}
          onPick={(row) => void pick(row)}
          onCreate={(kind, name) => void create(kind, name)}
        />
      ) : null}
    </div>
  )
}

export function RecipeItemsTable({
  items,
  invalidKey = null,
  canEdit,
  recipeId,
  ingredientTargets,
  recipeTargets,
  onIngredientActivated,
  onPatch,
  onOpenImport,
  onAddSteps,
  scale = 1,
  onReorder,
  onRemove,
  onAdd,
  percentMode,
  onPercentModeChange,
  percentageMode,
  onPercentageModeChange,
  onSetBase,
  weighAlerts,
}: RecipeItemsTableProps) {
  const [quickAdd, setQuickAdd] = React.useState("")
  const [quickAddError, setQuickAddError] = React.useState<string | null>(null)
  const [quickAddOpen, setQuickAddOpen] = React.useState(false)
  const [quickAddHighlighted, setQuickAddHighlighted] = React.useState(-1)
  // The row a new header, note or quick-add lands after: wherever the cook is
  // working, not the bottom of a long list.
  const [activeKey, setActiveKey] = React.useState<string | null>(null)
  const activeKeyRef = React.useRef<string | null>(null)
  const quickAddTail = React.useRef<Promise<void>>(Promise.resolve())
  const rememberActiveKey = (key: string | null) => {
    activeKeyRef.current = key
    setActiveKey(key)
  }
  // Catalog lookup and activation are asynchronous. Keep consecutive Enter
  // presses in the order they were submitted, regardless of response order.
  const enqueueQuickAdd = (
    operation: (after: string | null) => string | null | Promise<string | null>
  ) => {
    const queued = quickAddTail.current.then(async () => {
      rememberActiveKey(await operation(activeKeyRef.current))
    })
    // One failed lookup must not prevent later Enter presses from running.
    quickAddTail.current = queued.catch(() => undefined)
  }
  // The sub-recipe rows opened in place. Collapsed is the resting state: a
  // long recipe should still read as a list of lines.
  const [expanded, setExpanded] = React.useState<string[]>([])
  const hydrated = useHydrated()
  const toggleExpanded = (key: string) =>
    setExpanded((current) =>
      current.includes(key)
        ? current.filter((one) => one !== key)
        : [...current, key]
    )
  const bodyRef = React.useRef<HTMLTableSectionElement>(null)
  useSortableRows(bodyRef, canEdit, onReorder)

  const pickerRecipes = React.useMemo(
    () => recipeTargets.filter((one) => one.id !== recipeId),
    [recipeTargets, recipeId]
  )

  const [showNotes, setShowNotes] = React.useState(true)
  const bakers = percentageMode === "bakers"
  // This browser's last choices, for the next recipe that has none. Read
  // after mount: the server cannot know what this browser prefers.
  const choosePercentageMode = (mode: string) => {
    onPercentageModeChange(mode)
    window.localStorage.setItem(PERCENT_MODE_KEY, mode)
  }
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowNotes(window.localStorage.getItem(NOTES_COLUMN_KEY) !== "hidden")
  }, [])
  const toggleNotes = (visible: boolean) => {
    setShowNotes(visible)
    window.localStorage.setItem(NOTES_COLUMN_KEY, visible ? "shown" : "hidden")
  }
  const measured = items.filter((item) => isMeasured(item.kind))
  // Without a chosen base the biggest line stands in, which is the flour
  // often enough to be a useful default.
  const base =
    measured.find((item) => item.isBase) ??
    measured.reduce<RecipeItemState | null>(
      (best, item) =>
        !best || (Number(item.quantity) || 0) > (Number(best.quantity) || 0)
          ? item
          : best,
      null
    )
  const quantityTotal = bakers
    ? Number(base?.quantity) || 0
    : measured.reduce((total, item) => total + (Number(item.quantity) || 0), 0)
  const columns = 5 + Number(showNotes) + Number(percentMode)

  const quickAddParsed = React.useMemo(() => {
    const text = quickAdd.trim()
    return text ? parseRecipeText(text) : null
  }, [quickAdd])
  const quickAddLine = quickAddParsed?.parsedLines[0] ?? null
  // The qualifier becomes the note, so the name the cook searches on and the
  // name the row takes are both the bare ingredient. "1 cup" on its own is a
  // measure still waiting for its name, not a name.
  const quickAddName =
    /^[#>]/.test(quickAdd.trim()) || NOTE_PATTERN.test(quickAdd.trim())
      ? ""
      : (quickAddLine?.baseName.trim() ??
        (quickAddParsed?.skippedLines[0]?.affectsPricing
          ? ""
          : quickAdd.trim()))
  const quickAddRows = useIngredientSuggestions(
    quickAddName,
    ingredientTargets,
    NO_RECIPES,
    null,
    false
  )

  /** The parsed amount and unit survive whichever row the cook lands on. */
  const lineMeasure = (line: ParsedRecipeLine | null) => {
    const written = line?.normalizedUnit ?? ""
    const unit = written === "assumed-g" ? "g" : written
    return {
      // Typed at the batch being viewed; the recipe keeps the 1x amount.
      quantity: !line
        ? clampRecipeQuantity(1 / scale)
        : line.alert === "unmeasured"
          ? ""
          : clampRecipeQuantity(line.enteredAmount / scale),
      unit: unit && KNOWN_UNITS[unit] ? unit : "each",
      preparationNote: line?.noteText ?? line?.qualifier ?? "",
    }
  }
  const quickAddMeasure = () => lineMeasure(quickAddLine)

  /** What a new line may link to: the picker offers no supply, and neither
   * does the matching behind a typed or pasted name. */
  const edibleTargets = () => ingredientTargets.filter((one) => !one.nonEdible)

  /**
   * A line the cook typed or pasted, linked the way they would link it by
   * hand: their pantry, then their recipes, then the catalog. `pantry` grows
   * as catalog picks land in it, so the second "eggs" of a paste is already
   * theirs by the time it is read.
   */
  const addResolvedLine = async (
    line: ParsedRecipeLine | null,
    name: string,
    after: string | null,
    pantry: Target[]
  ) => {
    const resolved = await resolveLine(
      {
        baseName: name,
        qualifier: line?.qualifier ?? null,
        noteText: line?.noteText ?? null,
        identityCandidates: line?.identityCandidates ?? [],
        sizeWord: line?.sizeWord ?? null,
      },
      {
        ingredients: pantry,
        recipes: pickerRecipes,
        searchCatalog: searchCatalogIngredients,
        activateCatalog: activateCatalogIngredient,
      }
    )
    if (resolved?.activated) {
      pantry.push(resolved.activated)
      onIngredientActivated(resolved.activated)
    }
    return onAdd(
      "ingredient",
      { ...lineMeasure(line), displayName: name, ...resolved?.patch },
      after
    )
  }

  /**
   * A whole list at once, the way a cook pastes one into the field: written
   * order kept, nothing dropped, however the copied list broke its lines. A
   * single-line field drops the newlines, so the paste itself is read rather
   * than the value it would leave behind.
   */
  const addPastedLines = async (text: string) => {
    const whole = text.replace(/\r\n?|[\u2028\u2029]/g, "\n")
    // A cook pastes the whole page: the method half becomes steps, and only
    // the list reaches this table.
    const split = onAddSteps
      ? splitRecipeDocument(whole)
      : { ingredients: whole, method: "" }
    if (split.method) onAddSteps?.(split.method)
    const parsed = parseRecipeText(split.ingredients)
    const written = [
      ...parsed.headerLines,
      ...parsed.noteLines,
      ...parsed.skippedLines.map((line) => ({
        kind: "skipped" as const,
        lineNumber: line.lineNumber,
        rawLine: line.rawLine,
      })),
      ...parsed.parsedLines,
    ].sort((left, right) => left.lineNumber - right.lineNumber)
    const pantry = edibleTargets()
    let after = activeKey
    for (const line of written) {
      if (line.kind === "ingredient") {
        try {
          after = await addResolvedLine(
            line,
            line.baseName.trim(),
            after,
            pantry
          )
        } catch {
          // A lookup that failed must not cost the lines behind it: the row
          // lands as written, unlinked, and the table flags it in amber.
          after = onAdd(
            "ingredient",
            { ...lineMeasure(line), displayName: line.baseName.trim() },
            after
          )
        }
        continue
      }
      // A line the parser could not read is still the cook's: "# Filling" and
      // "> chill overnight" become their rows, anything else stays as a note.
      const raw = line.kind === "skipped" ? line.rawLine.trim() : ""
      const heading = raw.match(HEADING_PATTERN)
      const note = raw.match(NOTE_PATTERN)
      after = onAdd(
        line.kind === "header" || heading ? "header" : "note",
        {
          displayName:
            line.kind === "skipped"
              ? ((heading ?? note)?.[1] ?? raw)
              : line.text,
        },
        after
      )
    }
    rememberActiveKey(after)
  }

  const submitQuickAdd = () => {
    const text = quickAdd.trim()
    if (!text) return
    // "# For the batter" is a section, the way a pasted recipe writes one.
    const heading = text.match(HEADING_PATTERN)
    const note = text.match(NOTE_PATTERN)
    if (heading || note) {
      setQuickAdd("")
      setQuickAddHighlighted(-1)
      enqueueQuickAdd((after) =>
        onAdd(
          heading ? "header" : "note",
          { displayName: (heading ?? note)![1] },
          after
        )
      )
      return
    }
    if (!quickAddName) return
    const line = quickAddLine
    const name = quickAddName
    setQuickAdd("")
    setQuickAddHighlighted(-1)
    enqueueQuickAdd((after) =>
      addResolvedLine(line, name, after, edibleTargets())
    )
  }

  /** A whole list at once: the field empties and every line becomes a row. */
  const takeLines = (text: string) => {
    setQuickAdd("")
    setQuickAddOpen(false)
    setQuickAddHighlighted(-1)
    void addPastedLines(text)
  }

  const pickQuickAdd = (row: SuggestionRow) => {
    const measure = quickAddMeasure()
    setQuickAdd("")
    setQuickAddHighlighted(-1)
    enqueueQuickAdd(async (after) => {
      const picked = await pickSuggestion(row, measure.preparationNote)
      if (!picked) return after
      if (picked.activated) onIngredientActivated(picked.activated)
      return onAdd("ingredient", { ...measure, ...picked.patch }, after)
    })
  }

  return (
    <>
      <TableFrame>
        {/* Fixed layout so a long name truncates instead of widening the table. */}
        <Table className="table-fixed">
          <TableHeader>
            <TableHeaderRow>
              <TableHead className="w-6 pl-1 sm:w-8 sm:pl-3" />
              <TableHead className="w-16 text-sm text-muted-foreground sm:w-[96px]">
                Qty
              </TableHead>
              <TableHead className="w-20 text-sm text-muted-foreground sm:w-24">
                Unit
              </TableHead>
              <TableHead className="text-sm text-muted-foreground">
                Ingredient / Recipe
              </TableHead>
              {showNotes ? (
                <TableHead className="hidden text-sm text-muted-foreground sm:table-cell">
                  Notes
                </TableHead>
              ) : null}
              {percentMode ? (
                <TableHead className="w-16 text-right text-sm text-muted-foreground">
                  <Menu>
                    <MenuTrigger
                      render={
                        <button type="button" className={inlineChipClassName} />
                      }
                      aria-label="Percentage mode"
                      className="ml-auto"
                    >
                      <span className="underline decoration-1 underline-offset-2">
                        {bakers ? "Baker’s %" : "%"}
                      </span>
                      <ChevronDown
                        className="size-3.5"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </MenuTrigger>
                    <MenuContent align="end" className="w-40">
                      <MenuCheckItem
                        checked={!bakers}
                        onClick={() => choosePercentageMode("standard")}
                      >
                        Standard %
                      </MenuCheckItem>
                      <MenuCheckItem
                        checked={bakers}
                        onClick={() => choosePercentageMode("bakers")}
                      >
                        Baker’s %
                      </MenuCheckItem>
                    </MenuContent>
                  </Menu>
                </TableHead>
              ) : null}
              <TableHead className="w-10 sm:w-16">
                <div className="flex">
                  <ColumnsMenu
                    columns={[
                      {
                        id: "notes",
                        label: "Notes",
                        visible: showNotes,
                        onToggle: toggleNotes,
                      },
                      {
                        id: "percent",
                        label: "%",
                        visible: percentMode,
                        onToggle: onPercentModeChange,
                      },
                    ]}
                  />
                </div>
              </TableHead>
            </TableHeaderRow>
          </TableHeader>
          <TableBody ref={bodyRef}>
            {items.length === 0 ? (
              <TableRow className="h-11 hover:!bg-transparent">
                <TableCell
                  colSpan={columns}
                  className="pl-3 text-base text-muted-foreground"
                >
                  No ingredients yet.
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => {
                const share =
                  quantityTotal > 0
                    ? ((Number(item.quantity) || 0) / quantityTotal) * 100
                    : 0
                const child =
                  item.kind === "subrecipe" ? (item.subrecipe ?? null) : null
                const open = child !== null && expanded.includes(item.key)
                return (
                  <React.Fragment key={item.key}>
                    <TableRow
                      data-sortable-row
                      aria-invalid={item.key === invalidKey || undefined}
                      className={cn(
                        "group/row h-11 hover:!bg-transparent",
                        item.key === invalidKey && "bg-destructive-fill"
                      )}
                      onFocusCapture={() => rememberActiveKey(item.key)}
                    >
                      <TableCell className="w-6 pl-1 sm:w-8 sm:pl-3">
                        {canEdit ? (
                          <span
                            data-drag-handle
                            aria-hidden="true"
                            className={dragHandleClassName}
                          >
                            <GripVertical className="size-4" />
                          </span>
                        ) : null}
                      </TableCell>
                      {isMeasured(item.kind) ? (
                        <>
                          <TableCell className="w-16 sm:w-[96px]">
                            <QuantityCell
                              item={item}
                              canEdit={canEdit}
                              scale={scale}
                              onPatch={onPatch}
                              weighAlert={weighAlerts?.[item.key] ?? null}
                            />
                          </TableCell>
                          <TableCell className="w-20 sm:w-24">
                            <Select
                              value={shownMeasure(item, scale).unit}
                              disabled={!canEdit}
                              onValueChange={(next) => {
                                // The number stays, the unit changes: at 2x the
                                // shown amount is what the cook meant.
                                const shown = shownMeasure(item, scale)
                                onPatch(item.key, {
                                  unit: String(next),
                                  quantity:
                                    scale === 1 || !shown.amount
                                      ? item.quantity
                                      : clampRecipeQuantity(
                                          Number(shown.amount) / scale
                                        ),
                                })
                              }}
                            >
                              <SelectTrigger
                                size="sm"
                                aria-label="Unit"
                                className="w-full border-transparent bg-transparent px-2 text-base enabled:not-focus:hover:border-transparent"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="w-56">
                                <UnitOptions />
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="min-w-0 flex-1">
                                {item.kind === "subrecipe" ? (
                                  <div className="flex items-center gap-1">
                                    <div className="min-w-0 flex-1">
                                      {canEdit ? (
                                        <TargetPicker
                                          item={item}
                                          canEdit={canEdit}
                                          ingredientTargets={ingredientTargets}
                                          recipeTargets={pickerRecipes}
                                          onPatch={onPatch}
                                          onIngredientActivated={
                                            onIngredientActivated
                                          }
                                        />
                                      ) : (
                                        <span className="block truncate px-2 text-base">
                                          {item.displayName}
                                        </span>
                                      )}
                                    </div>
                                    {child ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label={
                                          open
                                            ? "Hide sub-recipe"
                                            : "Show sub-recipe"
                                        }
                                        aria-expanded={open}
                                        onClick={() => toggleExpanded(item.key)}
                                      >
                                        {open ? (
                                          <ChevronDown aria-hidden="true" />
                                        ) : (
                                          <ChevronRight aria-hidden="true" />
                                        )}
                                      </Button>
                                    ) : item.subrecipeId ? (
                                      // Linked in this session and not saved yet, so
                                      // there are no lines to open in place. Reserve
                                      // the toggle footprint until the saved row arrives.
                                      <span
                                        className="size-6 shrink-0"
                                        aria-hidden="true"
                                      />
                                    ) : null}
                                  </div>
                                ) : (
                                  <TargetPicker
                                    item={item}
                                    canEdit={canEdit}
                                    ingredientTargets={ingredientTargets}
                                    recipeTargets={pickerRecipes}
                                    onPatch={onPatch}
                                    onIngredientActivated={
                                      onIngredientActivated
                                    }
                                  />
                                )}
                              </div>
                              {item.excludedFromCost ? (
                                <span className="shrink-0 text-2xs text-muted-foreground">
                                  Not costed
                                </span>
                              ) : null}
                            </div>
                          </TableCell>
                          {showNotes ? (
                            <TableCell className="hidden sm:table-cell">
                              <NotesCell
                                item={item}
                                canEdit={canEdit}
                                ingredientTargets={ingredientTargets}
                                onPatch={onPatch}
                              />
                            </TableCell>
                          ) : null}
                          {percentMode ? (
                            <TableCell
                              className={cn(
                                "w-16 text-right text-base text-muted-foreground tabular-nums",
                                bakers &&
                                  item.key === base?.key &&
                                  "font-medium text-foreground"
                              )}
                            >
                              {share.toFixed(1)}%
                            </TableCell>
                          ) : null}
                        </>
                      ) : (
                        <TableCell colSpan={columns - 2}>
                          <Input
                            className={cn(
                              cellInput,
                              item.kind === "header"
                                ? "font-medium"
                                : "text-muted-foreground italic"
                            )}
                            value={item.displayName}
                            disabled={!canEdit}
                            placeholder={
                              item.kind === "header"
                                ? "Section heading"
                                : "Note"
                            }
                            aria-label={
                              item.kind === "header" ? "Heading" : "Note"
                            }
                            onChange={(event) =>
                              onPatch(item.key, {
                                displayName: event.target.value,
                              })
                            }
                          />
                        </TableCell>
                      )}
                      <TableCell className="w-10 sm:w-16">
                        {canEdit ? (
                          <RowActionsMenu
                            label={`Actions for ${item.displayName || "row"}`}
                          >
                            {bakers &&
                            isMeasured(item.kind) &&
                            item.key !== base?.key ? (
                              <MenuItem onClick={() => onSetBase(item.key)}>
                                <Anchor strokeWidth={1.8} aria-hidden="true" />
                                Use as base
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
                        ) : null}
                      </TableCell>
                    </TableRow>
                    {open && child ? (
                      <SubrecipePanel
                        child={child}
                        amount={shownMeasure(item, scale).amount}
                        unit={shownMeasure(item, scale).unit}
                        columns={columns}
                      />
                    ) : null}
                  </React.Fragment>
                )
              })
            )}
          </TableBody>
        </Table>
      </TableFrame>

      {canEdit ? (
        <>
          <div className="relative mt-2">
            <Input
              className="h-8 pr-8 text-base"
              value={quickAdd}
              placeholder="250 g cake flour, sifted · # Section · > Note"
              readOnly={!hydrated}
              aria-label="Quick add ingredient"
              onFocus={() => setQuickAddOpen(true)}
              onBlur={() => {
                setQuickAddOpen(false)
                setQuickAddHighlighted(-1)
              }}
              onChange={(event) => {
                setQuickAdd(event.target.value)
                setQuickAddHighlighted(-1)
                setQuickAddOpen(true)
                setQuickAddError(null)
              }}
              onPaste={(event) => {
                const field = event.currentTarget
                // What the field would hold after the paste, so a line half
                // typed before it is not thrown away with the paste.
                const whole =
                  quickAdd.slice(0, field.selectionStart ?? quickAdd.length) +
                  event.clipboardData.getData("text") +
                  quickAdd.slice(field.selectionEnd ?? quickAdd.length)
                // One line pasted stays editable, as a typed one does.
                if (!LINE_BREAK.test(whole.trim())) return
                event.preventDefault()
                takeLines(whole)
              }}
              onKeyDown={(event) => {
                if (
                  navigateSuggestions(
                    event,
                    quickAddRows.length,
                    setQuickAddHighlighted
                  )
                ) {
                  if (event.key === "Escape") setQuickAddOpen(false)
                  return
                }
                if (event.key !== "Enter") return
                event.preventDefault()
                const row =
                  quickAddHighlighted >= 0
                    ? quickAddRows[quickAddHighlighted]
                    : null
                if (row) void pickQuickAdd(row)
                else void submitQuickAdd()
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Add line"
              className="absolute top-1 right-1"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (!quickAdd.trim()) {
                  setQuickAddError("Type an ingredient or recipe to add.")
                  return
                }
                const row =
                  quickAddHighlighted >= 0
                    ? quickAddRows[quickAddHighlighted]
                    : null
                if (row) void pickQuickAdd(row)
                else void submitQuickAdd()
              }}
            >
              <Plus aria-hidden="true" />
            </Button>
            {quickAddOpen && quickAddName && quickAddRows.length > 0 ? (
              <IngredientSuggestions
                rows={quickAddRows}
                text={quickAddName}
                highlighted={quickAddHighlighted}
                selectedId={null}
                onPick={(row) => void pickQuickAdd(row)}
              />
            ) : null}
          </div>
          {quickAddError ? (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {quickAddError}
            </p>
          ) : null}
          <AddButton className="mt-2" onClick={onOpenImport} />
        </>
      ) : null}
    </>
  )
}
