"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { ChevronDown, ClipboardPaste, Plus, X } from "lucide-react"

import {
  GuardedLink,
  useGuardedNavigate,
} from "@/components/navigation-blocker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FilterPill } from "@/components/ui/filter-pill"
import { SearchInput, inputClassName } from "@/components/ui/input"
import {
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuTrigger,
} from "@/components/ui/menu"
import { EmptyState } from "@/components/ui/page"
import { TabPill, TabPills } from "@/components/ui/tab-pills"
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
import { Textarea } from "@/components/ui/textarea"
import type { PriceListEntry } from "@/lib/pricing"
import {
  COMPARE_PATH,
  compareFormulas,
  FORMULA_ROLE_LABELS,
  FORMULA_ROLES,
  gramOverrideKey,
  MAX_COMPARE_RECIPES,
  pastedFormulaInput,
  type ComparisonGroup,
  type ComparisonRow,
  type Formula,
  type FormulaInput,
  type FormulaLine,
  type FormulaOverrides,
  type PercentMode,
  type FormulaRole,
} from "@/lib/recipe/compare"
import { splitRecipeDocument } from "@/lib/recipe/split-document"
import { cn } from "@/lib/utils"

/**
 * Recipes side by side as a baker reads them: every flour line together is
 * 100% and the rest is a share of it. The saved columns are the ids in the
 * URL, so a comparison can be sent to someone; the pasted ones live in this
 * browser only, because a recipe copied from a book is research, not a
 * recipe of the kitchen's.
 */

/** The recipes pasted here, as text: identities differ between visits, so
 * they are read again on every load. */
export const COMPARE_PASTED_KEY = "recipe.compare.pasted"
export const COMPARE_GRAMS_KEY = "recipe.compare.grams"
export const COMPARE_MODE_KEY = "recipe.compare.percentMode"

export type CompareView = "formula" | "spec"
export type PastedRecipe = { id: string; title: string; text: string }

type RecipeOption = {
  publicId: string
  title: string
  category?: string | null
}

type CellValue = {
  percent: number | null
  grams: number | null
  line: FormulaLine | null
  present: boolean
}

type PlotRow = {
  key: string
  label: string
  role: FormulaRole
  group: ComparisonGroup
  row: ComparisonRow | null
  kind: "group" | "ingredient"
  values: CellValue[]
}

const percentFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const gramsFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
})

const COLUMN_COLORS = [
  { dot: "bg-chart-1", fill: "bg-chart-1" },
  { dot: "bg-chart-3", fill: "bg-chart-3" },
  { dot: "bg-chart-6", fill: "bg-chart-6" },
  { dot: "bg-chart-4", fill: "bg-chart-4" },
] as const

const MODE_OPTIONS: Array<{ value: PercentMode; label: string }> = [
  { value: "bakers", label: "Baker's %" },
  { value: "weight", label: "Weight %" },
]

const SPEC_GRID_CLASSES: Record<number, string> = {
  1: "grid-cols-[repeat(1,minmax(260px,1fr))]",
  2: "grid-cols-[repeat(2,minmax(260px,1fr))]",
  3: "grid-cols-[repeat(3,minmax(260px,1fr))]",
  4: "grid-cols-[repeat(4,minmax(260px,1fr))]",
}

export function formatComparePercent(percent: number | null): string {
  return percent === null ? "—" : `${percentFormat.format(percent)}%`
}

export function formatCompareDeltaPoints(delta: number | null): string {
  if (delta === null) return "—"
  if (Math.abs(delta) < 0.05) return "same"
  return `${delta > 0 ? "+" : "−"}${percentFormat.format(Math.abs(delta))} pts`
}

export function formatCompareGrams(grams: number | null): string {
  return grams === null ? "—" : `${gramsFormat.format(Math.round(grams))} g`
}

export function compareRowStats(values: Array<number | null>): {
  min: number | null
  max: number | null
  spread: number
} {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return { min: null, max: null, spread: 0 }
  const min = Math.min(...present)
  const max = Math.max(...present)
  return { min, max, spread: Math.round((max - min) * 10) / 10 }
}

export function formulaAxisMax(values: Array<number | null>): number {
  const max = compareRowStats(values).max ?? 0
  if (max <= 100) return 100
  return (Math.floor(max / 50) + 1) * 50
}

function formatAxisTick(value: number): string {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value)}%`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function readPasted(): PastedRecipe[] {
  const raw = window.localStorage.getItem(COMPARE_PASTED_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (one): one is PastedRecipe =>
        typeof one === "object" &&
        one !== null &&
        typeof (one as PastedRecipe).id === "string" &&
        typeof (one as PastedRecipe).title === "string" &&
        typeof (one as PastedRecipe).text === "string"
    )
  } catch {
    return []
  }
}

/** The group a row belongs to, chosen on the page; applies to every column. */
function RoleMenu({
  label,
  role,
  onChoose,
}: {
  label: string
  role: FormulaRole
  onChoose: (role: FormulaRole) => void
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Group for ${label}`}
          />
        }
      >
        <ChevronDown strokeWidth={2} aria-hidden="true" />
      </MenuTrigger>
      <MenuContent align="start" className="w-40">
        {FORMULA_ROLES.map((option) => (
          <MenuCheckItem
            key={option}
            checked={option === role}
            onClick={() => onChoose(option)}
          >
            {FORMULA_ROLE_LABELS[option]}
          </MenuCheckItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

/**
 * Grams typed for a line nothing could weigh. The field stays once filled:
 * a number the page was told is still the page's, not the recipe's.
 */
function GramsInput({
  label,
  column,
  value,
  onCommit,
}: {
  label: string
  column: string
  value: number | undefined
  onCommit: (grams: number | null) => void
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const text = draft.trim().replace(",", ".")
    setDraft(null)
    if (!text) {
      onCommit(null)
      return
    }
    const grams = Number(text)
    if (Number.isFinite(grams) && grams > 0) onCommit(grams)
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={`Grams for ${label} in ${column}`}
      placeholder="g"
      value={draft ?? (value === undefined ? "" : String(value))}
      onFocus={() => setDraft(value === undefined ? "" : String(value))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur()
      }}
      className={cn(
        inputClassName,
        "ml-auto h-7 w-20 px-2 text-right text-sm tabular-nums md:text-sm"
      )}
    />
  )
}

/** A recipe from anywhere, as text. A name is optional: the first heading
 * of the paste stands in. */
function PasteFormulaDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (title: string, text: string) => void
}) {
  const [title, setTitle] = React.useState("")
  const [text, setText] = React.useState("")
  const [error, setError] = React.useState("")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Paste a recipe</DialogTitle>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-base text-destructive">
            {error}
          </p>
        ) : null}
        <div className="grid gap-5">
          <div className="grid gap-2">
            <label
              htmlFor="paste-formula-title"
              className="text-sm font-medium"
            >
              Name
            </label>
            <input
              id="paste-formula-title"
              autoFocus
              maxLength={120}
              value={title}
              placeholder="Serious Eats focaccia"
              onChange={(event) => setTitle(event.target.value)}
              className={inputClassName}
            />
          </div>
          <div className="grid gap-2">
            <label htmlFor="paste-formula-text" className="text-sm font-medium">
              Ingredients
            </label>
            <Textarea
              id="paste-formula-text"
              className="min-h-64 bg-card"
              value={text}
              placeholder={"500 g bread flour\n2 cups water\n10 g salt"}
              onChange={(event) => setText(event.target.value)}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              One ingredient per line. A line the page cannot weigh keeps its
              row, with a box to type the grams.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (!text.trim()) {
                setError("Paste the ingredient list first.")
                return
              }
              // A whole page copied at once carries the method too; only
              // the ingredient half is a formula.
              const split = splitRecipeDocument(text)
              onAdd(title.trim(), split.method ? split.ingredients : text)
              setError("")
              setTitle("")
              setText("")
              onOpenChange(false)
            }}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formulaBasisLine(formula: Formula): string {
  if (formula.basis === "none") return `${formula.title}: nothing weighed yet.`
  return `${formula.title}: 100% = ${formula.basisLabel}.`
}

function basisNote(formula: Formula): string | null {
  if (formula.basis === "base" || formula.basis === "heaviest") {
    return `100% = ${formula.basisLabel}`
  }
  if (formula.basis === "none") return "Nothing weighed"
  return null
}

function compareUrl({
  selected,
  view,
  baseId,
}: {
  selected: string[]
  view: CompareView
  baseId: string | null
}): string {
  const parts: string[] = []
  if (selected.length) {
    parts.push(`r=${selected.map(encodeURIComponent).join(",")}`)
  }
  parts.push(`view=${view}`)
  if (baseId) parts.push(`base=${encodeURIComponent(baseId)}`)
  return `${COMPARE_PATH}?${parts.join("&")}`
}

function lineOverrideId(
  formula: Formula,
  line: FormulaLine,
  gramOverrides: Record<string, number>
): string | null {
  return (
    line.lineIds.find(
      (id) => gramOverrides[gramOverrideKey(formula.key, id)] !== undefined
    ) ??
    line.unweighedLineId ??
    null
  )
}

function groupValue(
  group: ComparisonGroup,
  index: number,
  row: ComparisonRow | null
): CellValue {
  if (row) {
    const line = row.cells[index] ?? null
    return {
      percent: line?.percent ?? null,
      grams: line?.grams ?? null,
      line,
      present: line !== null,
    }
  }
  const present = group.rows.some((one) => one.cells[index] !== null)
  const cell = group.subtotal.cells[index]
  return {
    percent: present ? (cell?.percent ?? null) : null,
    grams: present ? (cell?.grams ?? null) : null,
    line: null,
    present,
  }
}

function groupPlotRow(group: ComparisonGroup, columns: Formula[]): PlotRow {
  const row = group.rows.length === 1 ? (group.rows[0] ?? null) : null
  return {
    key: `group:${group.role}`,
    label: row ? row.label : group.label,
    role: group.role,
    group,
    row,
    kind: "group",
    values: columns.map((_, index) => groupValue(group, index, row)),
  }
}

function ingredientPlotRow(
  group: ComparisonGroup,
  row: ComparisonRow,
  columns: Formula[]
): PlotRow {
  return {
    key: row.key,
    label: row.label,
    role: group.role,
    group,
    row,
    kind: "ingredient",
    values: columns.map((_, index) => groupValue(group, index, row)),
  }
}

function AddRecipePopover({
  disabled,
  recipeOptions,
  selected,
  pending,
  onChoose,
  onPaste,
  className,
}: {
  disabled: boolean
  recipeOptions: RecipeOption[]
  selected: string[]
  pending: boolean
  onChoose: (publicId: string) => void
  onPaste: () => void
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const needle = query.trim().toLocaleLowerCase()
  const matches = recipeOptions.filter((option) =>
    option.title.toLocaleLowerCase().includes(needle)
  )
  const firstEnabled = matches.find(
    (option) => !selected.includes(option.publicId)
  )
  const choose = (publicId: string) => {
    onChoose(publicId)
    setOpen(false)
    setQuery("")
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery("")
      }}
    >
      <Popover.Trigger
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border bg-card px-3 text-sm leading-none font-medium text-foreground outline-none hover:border-line-strong focus-visible:border-foreground disabled:cursor-not-allowed disabled:text-disabled-foreground",
          className
        )}
      >
        <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
        Add recipe
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="z-50 w-64 origin-(--transform-origin) rounded-lg border border-popover-border bg-popover text-popover-foreground outline-none">
            <Popover.Title className="sr-only">Add recipe</Popover.Title>
            <div className="p-1.5">
              <SearchInput
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  if (firstEnabled) choose(firstEnabled.publicId)
                }}
                placeholder="Search recipes"
                aria-label="Search recipes"
                className="max-w-none"
                inputClassName="h-8"
              />
            </div>
            <div className="flex max-h-64 flex-col overflow-y-auto p-1.5 pt-0">
              {matches.length === 0 ? (
                <span className="flex h-9 shrink-0 items-center px-2.5 text-base text-faint">
                  No recipes match
                </span>
              ) : null}
              {matches.map((option) => {
                const chosen = selected.includes(option.publicId)
                return (
                  <button
                    key={option.publicId}
                    type="button"
                    disabled={chosen}
                    onClick={() => choose(option.publicId)}
                    className="flex min-h-9 w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:text-disabled-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate text-base">
                      {option.title}
                    </span>
                    {option.category ? (
                      <span className="max-w-20 truncate text-xs text-faint">
                        {option.category}
                      </span>
                    ) : null}
                  </button>
                )
              })}
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  setQuery("")
                  onPaste()
                }}
                className="mt-1 flex min-h-9 w-full items-center gap-2.5 rounded-md border-t border-border px-2.5 py-1.5 text-left text-base outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <ClipboardPaste
                  className="size-[17px]"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                Paste a recipe
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function RecipeChips({
  columns,
  selected,
  baseId,
  view,
  recipeOptions,
  pending,
  busy,
  onAdd,
  onRemove,
  onPaste,
  onToggleBase,
  onView,
}: {
  columns: Formula[]
  selected: string[]
  baseId: string | null
  view: CompareView
  recipeOptions: RecipeOption[]
  pending: boolean
  busy: string | null
  onAdd: (publicId: string) => void
  onRemove: (formula: Formula) => void
  onPaste: () => void
  onToggleBase: (formula: Formula) => void
  onView: (view: CompareView) => void
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {columns.map((formula, index) => {
          const active = formula.key === baseId
          return (
            <div
              key={formula.key}
              className={cn(
                "flex h-8 max-w-full items-center gap-1.5 rounded-full border border-border bg-card pr-1 pl-2.5",
                active && "border-foreground bg-muted"
              )}
            >
              <button
                type="button"
                aria-label={
                  active ? `${formula.title} baseline` : formula.title
                }
                onClick={() => onToggleBase(formula)}
                className="flex min-w-0 items-center gap-1.5 outline-none focus-visible:underline"
              >
                <span
                  className={cn(
                    "size-[9px] shrink-0 rounded-full",
                    COLUMN_COLORS[index]?.dot
                  )}
                  aria-hidden="true"
                />
                <span className="max-w-[220px] min-w-0 truncate text-sm font-medium text-foreground">
                  {formula.title}
                </span>
                {active ? (
                  <span className="text-xs text-muted-foreground">
                    baseline
                  </span>
                ) : null}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${formula.title}`}
                disabled={columns.length <= 2}
                pending={pending && busy === `remove:${formula.key}`}
                onClick={() => onRemove(formula)}
                className="size-6 rounded-full"
              >
                <X strokeWidth={2} aria-hidden="true" />
              </Button>
            </div>
          )
        })}
        {columns.length < MAX_COMPARE_RECIPES ? (
          <AddRecipePopover
            disabled={false}
            recipeOptions={recipeOptions}
            selected={selected}
            pending={pending && busy === "add"}
            onChoose={onAdd}
            onPaste={onPaste}
          />
        ) : null}
      </div>
      <TabPills>
        <TabPill active={view === "formula"} onClick={() => onView("formula")}>
          Formula
        </TabPill>
        <TabPill active={view === "spec"} onClick={() => onView("spec")}>
          Spec sheet
        </TabPill>
      </TabPills>
    </div>
  )
}

function FormulaValue({
  formula,
  value,
  baseline,
  isBaseline,
  showGrams,
  gramOverrides,
  onSetGrams,
  className,
}: {
  formula: Formula
  value: CellValue
  baseline: number | null
  isBaseline: boolean
  showGrams: boolean
  gramOverrides: Record<string, number>
  onSetGrams: (formulaKey: string, lineId: string, grams: number | null) => void
  className?: string
}) {
  const overrideId = value.line
    ? lineOverrideId(formula, value.line, gramOverrides)
    : null
  if (value.line?.note === "nonEdible") {
    return <span className="text-base text-muted-foreground">Not food</span>
  }
  if (value.line && overrideId !== null) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <GramsInput
          label={value.line.label}
          column={formula.title}
          value={gramOverrides[gramOverrideKey(formula.key, overrideId)]}
          onCommit={(grams) => onSetGrams(formula.key, overrideId, grams)}
        />
        {value.line.written ? (
          <span className="text-2xs text-faint">{value.line.written}</span>
        ) : null}
      </div>
    )
  }
  if (value.percent === null) {
    return <span className={cn("text-faint", className)}>—</span>
  }
  if (baseline !== null) {
    if (isBaseline) {
      return (
        <span className={cn("text-faint tabular-nums", className)}>
          {formatComparePercent(value.percent)}
        </span>
      )
    }
    return (
      <span className={cn("tabular-nums", className)}>
        {formatCompareDeltaPoints(value.percent - baseline)}
        <span className="block text-2xs font-normal text-faint">
          {formatComparePercent(value.percent)}
        </span>
      </span>
    )
  }
  return (
    <span className={cn("tabular-nums", className)}>
      {formatComparePercent(value.percent)}
      {showGrams && value.grams !== null ? (
        <span className="block text-2xs font-normal text-faint">
          {formatCompareGrams(value.grams)}
        </span>
      ) : null}
      {value.line?.note === "discarded" ? (
        <span className="block text-2xs font-normal text-faint">discarded</span>
      ) : null}
    </span>
  )
}

function DotPlot({
  row,
  columns,
  axisMax,
}: {
  row: PlotRow
  columns: Formula[]
  axisMax: number
}) {
  const stats = compareRowStats(row.values.map((value) => value.percent))
  return (
    <div className="relative h-full">
      {stats.min !== null && stats.max !== null && stats.spread > 0.05 ? (
        <span
          className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-border"
          style={{
            left: `${(stats.min / axisMax) * 100}%`,
            width: `${((stats.max - stats.min) / axisMax) * 100}%`,
          }}
          aria-hidden="true"
        />
      ) : null}
      {row.values.map((value, index) =>
        value.percent === null ? null : (
          <span
            key={columns[index]?.key ?? index}
            className={cn(
              "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card",
              row.kind === "group" ? "size-[11px]" : "size-2",
              COLUMN_COLORS[index]?.dot
            )}
            style={{ left: `${(value.percent / axisMax) * 100}%` }}
            title={`${columns[index]?.title ?? "Recipe"} · ${formatComparePercent(value.percent)}`}
            aria-hidden="true"
          />
        )
      )}
    </div>
  )
}

function FormulaView({
  columns,
  groups,
  baseId,
  mode,
  showGrams,
  expanded,
  gramOverrides,
  onExpandedChange,
  onChooseMode,
  onSetRole,
  onSetGrams,
  onToggleGrams,
}: {
  columns: Formula[]
  groups: ComparisonGroup[]
  baseId: string | null
  mode: PercentMode
  showGrams: boolean
  expanded: Record<string, boolean>
  gramOverrides: Record<string, number>
  onExpandedChange: (role: FormulaRole) => void
  onChooseMode: (mode: PercentMode) => void
  onSetRole: (rowKey: string, role: FormulaRole) => void
  onSetGrams: (formulaKey: string, lineId: string, grams: number | null) => void
  onToggleGrams: () => void
}) {
  const [scrolled, setScrolled] = React.useState(false)
  const groupRows = groups.map((group) => groupPlotRow(group, columns))
  const visibleRows = groupRows.flatMap((groupRow) => [
    groupRow,
    ...(expanded[groupRow.role]
      ? groupRow.group.rows.map((row) =>
          ingredientPlotRow(groupRow.group, row, columns)
        )
      : []),
  ])
  const axisMax = formulaAxisMax(
    visibleRows.flatMap((row) => row.values.map((value) => value.percent))
  )
  const axisTicks = [0, axisMax / 2, axisMax]
  const basisTitle = columns.map(formulaBasisLine).join(" ")
  const axisLabel = mode === "bakers" ? "Baker's %" : "Weight %"
  const stickyClass = cn(
    "sticky left-0 z-[1] bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:content-['']",
    scrolled ? "after:bg-border" : "after:bg-transparent"
  )
  return (
    <>
      <TableFrame
        className="overflow-x-auto"
        onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 0)}
      >
        <Table className="min-w-full">
          <TableHeader>
            <TableHeaderRow className="h-11">
              <TableHead
                title={basisTitle}
                className={cn(
                  "w-[168px] min-w-[168px] align-middle",
                  stickyClass
                )}
              >
                {axisLabel}
              </TableHead>
              <TableHead className="min-w-[320px] align-middle">
                <div className="relative h-11">
                  {axisTicks.map((tick, index) => (
                    <span
                      key={tick}
                      className={cn(
                        "absolute top-1/2 -translate-y-1/2 text-2xs text-faint",
                        index === 0
                          ? "left-0"
                          : index === 1
                            ? "left-1/2 -translate-x-1/2"
                            : "right-0"
                      )}
                    >
                      {formatAxisTick(tick)}
                    </span>
                  ))}
                </div>
              </TableHead>
              {columns.map((formula, index) => (
                <TableHead
                  key={formula.key}
                  className="w-[104px] min-w-[104px] text-right align-middle"
                >
                  <span className="flex min-w-0 items-center justify-end gap-1.5">
                    <span
                      className={cn(
                        "size-[7px] rounded-full",
                        COLUMN_COLORS[index]?.dot
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                      {formula.title}
                    </span>
                  </span>
                </TableHead>
              ))}
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {groupRows.map((groupRow) => (
              <React.Fragment key={groupRow.key}>
                <FormulaPlotRow
                  row={groupRow}
                  columns={columns}
                  axisMax={axisMax}
                  baseId={baseId}
                  mode={mode}
                  showGrams={showGrams}
                  expanded={expanded[groupRow.role] ?? false}
                  stickyClass={stickyClass}
                  gramOverrides={gramOverrides}
                  onExpandedChange={onExpandedChange}
                  onSetRole={onSetRole}
                  onSetGrams={onSetGrams}
                />
                {expanded[groupRow.role]
                  ? groupRow.group.rows.map((row) => (
                      <FormulaPlotRow
                        key={row.key}
                        row={ingredientPlotRow(groupRow.group, row, columns)}
                        columns={columns}
                        axisMax={axisMax}
                        baseId={baseId}
                        mode={mode}
                        showGrams={showGrams}
                        expanded={false}
                        stickyClass={stickyClass}
                        gramOverrides={gramOverrides}
                        onExpandedChange={onExpandedChange}
                        onSetRole={onSetRole}
                        onSetGrams={onSetGrams}
                      />
                    ))
                  : null}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </TableFrame>
      <div className="mt-3.5 flex flex-col gap-2 text-sm text-faint md:flex-row md:items-center">
        <p className="flex-1">
          {baseId
            ? `Differences in points against ${
                columns.find((formula) => formula.key === baseId)?.title ??
                "baseline"
              }. Click it again to clear.`
            : mode === "bakers"
              ? "Baker's percentages: each ingredient as a share of flour. Click a recipe to use it as the baseline."
              : "Weight percentages: each ingredient as a share of the dough. Click a recipe to use it as the baseline."}
        </p>
        <div className="flex items-center justify-end gap-2">
          <FilterPill
            label="Show"
            value={mode}
            options={MODE_OPTIONS}
            onSelect={onChooseMode}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={showGrams}
            onClick={onToggleGrams}
            className="h-7 rounded-full"
          >
            {showGrams ? "Weights shown" : "Weights hidden"}
          </Button>
        </div>
      </div>
    </>
  )
}

function FormulaPlotRow({
  row,
  columns,
  axisMax,
  baseId,
  mode,
  showGrams,
  expanded,
  stickyClass,
  gramOverrides,
  onExpandedChange,
  onSetRole,
  onSetGrams,
}: {
  row: PlotRow
  columns: Formula[]
  axisMax: number
  baseId: string | null
  mode: PercentMode
  showGrams: boolean
  expanded: boolean
  stickyClass: string
  gramOverrides: Record<string, number>
  onExpandedChange: (role: FormulaRole) => void
  onSetRole: (rowKey: string, role: FormulaRole) => void
  onSetGrams: (formulaKey: string, lineId: string, grams: number | null) => void
}) {
  const canExpand = row.kind === "group" && row.group.rows.length > 1
  const baseline = baseId
    ? (row.values[columns.findIndex((formula) => formula.key === baseId)]
        ?.percent ?? null)
    : null
  const note = mode === "bakers" && row.role === "liquid"
  return (
    <TableRow className={row.kind === "group" ? "h-14" : "h-10"}>
      <TableCell className={cn("w-[168px] min-w-[168px]", stickyClass)}>
        {canExpand ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => onExpandedChange(row.role)}
            className="flex min-w-0 items-center gap-1.5 text-left outline-none focus-visible:underline"
          >
            <ChevronDown
              className={cn("size-3 text-faint", expanded && "rotate-180")}
              strokeWidth={2}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block truncate text-md font-semibold text-foreground">
                {row.label}
              </span>
              {note ? (
                <span className="block text-xs text-faint">Hydration</span>
              ) : null}
            </span>
          </button>
        ) : (
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5",
              row.kind === "ingredient" && "pl-4"
            )}
          >
            <span className="min-w-0">
              <span
                className={cn(
                  "block truncate",
                  row.kind === "group"
                    ? "text-md font-semibold text-foreground"
                    : "text-base text-muted-foreground"
                )}
              >
                {row.label}
              </span>
              {row.kind === "group" && note ? (
                <span className="block text-xs text-faint">Hydration</span>
              ) : null}
            </span>
            {row.kind === "ingredient" && row.row ? (
              <RoleMenu
                label={row.label}
                role={row.row.role}
                onChoose={(role) => onSetRole(row.row?.key ?? row.key, role)}
              />
            ) : null}
          </div>
        )}
      </TableCell>
      <TableCell className="min-w-[320px]">
        <div className={row.kind === "group" ? "h-14" : "h-10"}>
          <DotPlot row={row} columns={columns} axisMax={axisMax} />
        </div>
      </TableCell>
      {columns.map((formula, index) => (
        <TableCell
          key={formula.key}
          className={cn(
            "w-[104px] min-w-[104px] text-right",
            row.kind === "group"
              ? "text-md font-medium text-foreground"
              : "text-base text-muted-foreground"
          )}
        >
          <FormulaValue
            formula={formula}
            value={
              row.values[index] ?? {
                percent: null,
                grams: null,
                line: null,
                present: false,
              }
            }
            baseline={baseline}
            isBaseline={formula.key === baseId}
            showGrams={showGrams}
            gramOverrides={gramOverrides}
            onSetGrams={onSetGrams}
          />
        </TableCell>
      ))}
    </TableRow>
  )
}

function SpecSheetView({
  columns,
  groups,
  baseId,
  mode,
  showGrams,
  gramOverrides,
  onSetGrams,
}: {
  columns: Formula[]
  groups: ComparisonGroup[]
  baseId: string | null
  mode: PercentMode
  showGrams: boolean
  gramOverrides: Record<string, number>
  onSetGrams: (formulaKey: string, lineId: string, grams: number | null) => void
}) {
  const groupRows = groups.map((group) => groupPlotRow(group, columns))
  return (
    <div className="overflow-x-auto">
      <div
        className={cn(
          "grid min-w-full gap-8",
          SPEC_GRID_CLASSES[columns.length] ?? SPEC_GRID_CLASSES[4]
        )}
      >
        {columns.map((formula, index) => (
          <div key={formula.key} className="min-w-0">
            <div className="pb-[22px]">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "size-[9px] rounded-full",
                    COLUMN_COLORS[index]?.dot
                  )}
                  aria-hidden="true"
                />
                {formula.href ? (
                  <GuardedLink
                    href={formula.href}
                    className="min-w-0 truncate text-lg font-semibold text-foreground hover:underline"
                  >
                    {formula.title}
                  </GuardedLink>
                ) : (
                  <span className="min-w-0 truncate text-lg font-semibold text-foreground">
                    {formula.title}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-faint">
                {formula.source === "pasted"
                  ? "Pasted recipe"
                  : (formula.category ?? "")}
                {formula.key === baseId ? (
                  <span className="font-medium text-foreground">
                    {" "}
                    · Baseline
                  </span>
                ) : null}
              </p>
              {basisNote(formula) ? (
                <p className="mt-1 text-sm text-faint">{basisNote(formula)}</p>
              ) : null}
              <p className="mt-1 text-sm text-muted-foreground">
                {formatCompareGrams(formula.roleTotals.flour.grams)} flour ·{" "}
                {formatCompareGrams(formula.totalGrams)} dough
              </p>
            </div>
            {groupRows.map((groupRow) => (
              <SpecSection
                key={groupRow.key}
                groupRow={groupRow}
                formula={formula}
                formulaIndex={index}
                columns={columns}
                baseId={baseId}
                mode={mode}
                showGrams={showGrams}
                gramOverrides={gramOverrides}
                onSetGrams={onSetGrams}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function SpecSection({
  groupRow,
  formula,
  formulaIndex,
  columns,
  baseId,
  mode,
  showGrams,
  gramOverrides,
  onSetGrams,
}: {
  groupRow: PlotRow
  formula: Formula
  formulaIndex: number
  columns: Formula[]
  baseId: string | null
  mode: PercentMode
  showGrams: boolean
  gramOverrides: Record<string, number>
  onSetGrams: (formulaKey: string, lineId: string, grams: number | null) => void
}) {
  const value = groupRow.values[formulaIndex] ?? {
    percent: null,
    grams: null,
    line: null,
    present: false,
  }
  const baseline =
    baseId && formula.key !== baseId
      ? (groupRow.values[columns.findIndex((one) => one.key === baseId)]
          ?.percent ?? null)
      : null
  const rowMax = compareRowStats(groupRow.values.map((one) => one.percent)).max
  const width =
    value.percent !== null && rowMax && rowMax > 0
      ? Math.max(0, Math.min(100, (value.percent / rowMax) * 100))
      : 0
  const sectionLabel =
    mode === "bakers" && groupRow.role === "liquid"
      ? "Hydration"
      : groupRow.group.label
  const showLines =
    groupRow.group.rows.length > 1 ||
    groupRow.group.rows.some((row) => row.label !== sectionLabel)
  return (
    <section className="border-t border-border py-4 pb-[18px]">
      <div className="text-xs font-medium text-muted-foreground">
        {sectionLabel}
      </div>
      {value.percent === null || !value.present ? (
        <div className="mt-1">
          <div className="text-2xl font-semibold text-faint tabular-nums">
            —
          </div>
          <div className="text-xs text-faint">Not in this recipe</div>
        </div>
      ) : (
        <>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={cn(
                "font-semibold text-foreground tabular-nums",
                groupRow.role === "liquid" ? "text-3xl" : "text-2xl"
              )}
            >
              {formatComparePercent(value.percent)}
            </span>
            {baseline !== null ? (
              <span className="text-sm font-medium text-muted-foreground">
                {formatCompareDeltaPoints(value.percent - baseline)}
              </span>
            ) : null}
          </div>
          <div className="mt-3 h-1 rounded-full bg-muted">
            <div
              className={cn(
                "h-1 rounded-full",
                COLUMN_COLORS[formulaIndex]?.fill
              )}
              style={{ width: `${width}%` }}
            />
          </div>
        </>
      )}
      {showLines ? (
        <div className="mt-3 grid gap-1.5">
          {groupRow.group.rows.map((row) => {
            const line = row.cells[formulaIndex]
            if (!line) return null
            return (
              <div key={row.key} className="flex min-w-0 items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {row.label}
                </span>
                <SpecLineValue
                  formula={formula}
                  line={line}
                  showGrams={showGrams}
                  gramOverrides={gramOverrides}
                  onSetGrams={onSetGrams}
                />
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

function SpecLineValue({
  formula,
  line,
  showGrams,
  gramOverrides,
  onSetGrams,
}: {
  formula: Formula
  line: FormulaLine
  showGrams: boolean
  gramOverrides: Record<string, number>
  onSetGrams: (formulaKey: string, lineId: string, grams: number | null) => void
}) {
  const overrideId = lineOverrideId(formula, line, gramOverrides)
  if (overrideId !== null) {
    return (
      <GramsInput
        label={line.label}
        column={formula.title}
        value={gramOverrides[gramOverrideKey(formula.key, overrideId)]}
        onCommit={(grams) => onSetGrams(formula.key, overrideId, grams)}
      />
    )
  }
  return (
    <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
      {formatComparePercent(line.percent)}
      {showGrams && line.grams !== null
        ? ` · ${formatCompareGrams(line.grams)}`
        : ""}
    </span>
  )
}

export function CompareFormulas({
  selected,
  formulas,
  missingCount,
  identities,
  recipeOptions,
  view,
  baseId,
}: {
  /** The saved recipes in the URL, in order. */
  selected: string[]
  formulas: FormulaInput[]
  /** Ids in the URL that could not be opened. */
  missingCount: number
  /** The pantry, for weighing pasted lines; empty where cost is not the reader's. */
  identities: PriceListEntry[]
  recipeOptions: RecipeOption[]
  view: CompareView
  baseId: string | null
}) {
  const { go, pending } = useGuardedNavigate()
  const [mode, setMode] = React.useState<PercentMode>("bakers")
  const [pasted, setPasted] = React.useState<PastedRecipe[]>([])
  const [showGrams, setShowGrams] = React.useState(false)
  const [gramOverrides, setGramOverrides] = React.useState<
    Record<string, number>
  >({})
  const [roleOverrides, setRoleOverrides] = React.useState<
    Record<string, FormulaRole>
  >({})
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})
  const [pasteOpen, setPasteOpen] = React.useState(false)
  // The control whose press started the navigation, so its wait shows there.
  const [busy, setBusy] = React.useState<string | null>(null)

  // This browser's last choices. Read after mount: the server cannot know
  // what this browser prefers or has pasted.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(
      window.localStorage.getItem(COMPARE_MODE_KEY) === "weight"
        ? "weight"
        : "bakers"
    )
    setShowGrams(window.localStorage.getItem(COMPARE_GRAMS_KEY) === "shown")
    setPasted(readPasted())
  }, [])

  const savePasted = (next: PastedRecipe[]) => {
    setPasted(next)
    window.localStorage.setItem(COMPARE_PASTED_KEY, JSON.stringify(next))
  }

  const pastedInputs = React.useMemo(
    () =>
      pasted.map((one) =>
        pastedFormulaInput(`paste:${one.id}`, one.title, one.text, identities)
      ),
    [pasted, identities]
  )
  const overrides = React.useMemo<FormulaOverrides>(
    () => ({ grams: gramOverrides, roles: roleOverrides }),
    [gramOverrides, roleOverrides]
  )
  const comparison = React.useMemo(
    () => compareFormulas([...formulas, ...pastedInputs], mode, overrides),
    [formulas, pastedInputs, mode, overrides]
  )
  const columns = comparison.formulas
  const selectedBase = columns.some((formula) => formula.key === baseId)
    ? baseId
    : null
  const full = columns.length >= MAX_COMPARE_RECIPES

  const navigate = (next: {
    selected?: string[]
    view?: CompareView
    baseId?: string | null
  }) => {
    void go(
      compareUrl({
        selected: next.selected ?? selected,
        view: next.view ?? view,
        baseId: next.baseId === undefined ? selectedBase : next.baseId,
      }),
      { replace: true }
    )
  }

  const addRecipe = (publicId: string) => {
    setBusy("add")
    navigate({ selected: [...selected, publicId] })
  }
  const remove = (formula: Formula) => {
    if (columns.length <= 2) return
    if (formula.source === "pasted") {
      savePasted(pasted.filter((one) => `paste:${one.id}` !== formula.key))
      if (selectedBase === formula.key) navigate({ baseId: null })
      return
    }
    setBusy(`remove:${formula.key}`)
    const nextSelected = selected.filter((id) => id !== formula.key)
    navigate({
      selected: nextSelected,
      baseId: selectedBase === formula.key ? null : selectedBase,
    })
  }
  const addPasted = (title: string, text: string) => {
    const id = crypto.randomUUID()
    savePasted([
      ...pasted,
      { id, title: title || `Pasted recipe ${pasted.length + 1}`, text },
    ])
  }
  const setGrams = (formulaKey: string, lineId: string, grams: number | null) =>
    setGramOverrides((current) => {
      const next = { ...current }
      const key = gramOverrideKey(formulaKey, lineId)
      if (grams === null) delete next[key]
      else next[key] = grams
      return next
    })
  const setRole = (rowKey: string, role: FormulaRole) =>
    setRoleOverrides((current) => ({ ...current, [rowKey]: role }))
  const chooseMode = (next: PercentMode) => {
    setMode(next)
    window.localStorage.setItem(COMPARE_MODE_KEY, next)
  }
  const toggleGrams = () =>
    setShowGrams((current) => {
      const next = !current
      window.localStorage.setItem(COMPARE_GRAMS_KEY, next ? "shown" : "hidden")
      return next
    })

  const pasteButton = (
    <Button type="button" disabled={full} onClick={() => setPasteOpen(true)}>
      <ClipboardPaste strokeWidth={1.8} aria-hidden="true" />
      Paste recipe
    </Button>
  )
  const addPopover = (
    <AddRecipePopover
      disabled={full}
      recipeOptions={recipeOptions}
      selected={selected}
      pending={pending && busy === "add"}
      onChoose={addRecipe}
      onPaste={() => setPasteOpen(true)}
    />
  )

  return (
    <>
      {columns.length === 0 ? (
        <EmptyState
          title="Compare recipes as baker's percentages"
          description="Select recipes on the Recipes list and choose Compare from Actions, or paste a recipe from anywhere to read it beside one of yours, or on its own."
        >
          {pasteButton}
          {addPopover}
        </EmptyState>
      ) : (
        <>
          <RecipeChips
            columns={columns}
            selected={selected}
            baseId={selectedBase}
            view={view}
            recipeOptions={recipeOptions}
            pending={pending}
            busy={busy}
            onAdd={addRecipe}
            onRemove={remove}
            onPaste={() => setPasteOpen(true)}
            onToggleBase={(formula) =>
              navigate({
                baseId: selectedBase === formula.key ? null : formula.key,
              })
            }
            onView={(nextView) => navigate({ view: nextView })}
          />
          {missingCount > 0 ? (
            <p className="mb-4 text-xs text-muted-foreground">
              {plural(missingCount, "selected recipe")} could not be opened.
            </p>
          ) : null}
          {columns.length === 1 ? (
            <EmptyState title="Add one more recipe to compare.">
              {pasteButton}
              {addPopover}
            </EmptyState>
          ) : view === "spec" ? (
            <SpecSheetView
              columns={columns}
              groups={comparison.groups}
              baseId={selectedBase}
              mode={mode}
              showGrams={showGrams}
              gramOverrides={gramOverrides}
              onSetGrams={setGrams}
            />
          ) : (
            <FormulaView
              columns={columns}
              groups={comparison.groups}
              baseId={selectedBase}
              mode={mode}
              showGrams={showGrams}
              expanded={expanded}
              gramOverrides={gramOverrides}
              onExpandedChange={(role) =>
                setExpanded((current) => ({
                  ...current,
                  [role]: !current[role],
                }))
              }
              onChooseMode={chooseMode}
              onSetRole={setRole}
              onSetGrams={setGrams}
              onToggleGrams={toggleGrams}
            />
          )}
        </>
      )}
      {columns.length === 0 && missingCount > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {plural(missingCount, "selected recipe")} could not be opened.
        </p>
      ) : null}
      <PasteFormulaDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        onAdd={addPasted}
      />
    </>
  )
}
