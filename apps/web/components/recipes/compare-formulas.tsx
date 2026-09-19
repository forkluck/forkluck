"use client"

import * as React from "react"
import {
  NoticeBanner,
  NoticeBannerAction,
  NoticeBannerActions,
} from "@/components/ui/notice-banner"
import { useRouter } from "next/navigation"
import {
  ChevronDown,
  ClipboardPaste,
  Link2,
  SquarePen,
  Trash2,
  X,
} from "lucide-react"

import {
  GuardedLink,
  useGuardedNavigate,
} from "@/components/navigation-blocker"
import {
  PriceLineDialog,
  type PriceLineMatch,
} from "@/components/ingredients/price-line-dialog"
import { ActionsMenu } from "@/components/ui/actions-menu"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SearchInput, inputClassName } from "@/components/ui/input"
import { LabeledInput } from "@/components/ui/labeled-field"
import {
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu"
import { EmptyState, Toolbar, ToolbarSpacer } from "@/components/ui/page"
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
import { useToast } from "@/components/ui/toast"
import { linkClassName } from "@/components/ui/link"
import { useCompareEdit } from "@/components/recipes/compare-chrome"
import { useDocumentSave, type SaveEcho } from "@/hooks/use-document-save"
import { useRefresh } from "@/hooks/use-refresh"
import { comparisonDraft, type ComparisonDraft } from "@/lib/draft-store"
import { toSaveFailure, type SaveFailure } from "@/lib/save-failure"
import type {
  LineMatchRow,
  SavedComparisonOverrides,
} from "@/lib/backend/types"
import {
  deleteComparison,
  saveComparison,
  type SaveComparisonInput,
} from "@/app/(app)/recipes/compare/actions"
import type { PriceListEntry, RecipeLineMatch } from "@/lib/pricing"
import {
  COMPARE_NEW_PATH,
  COMPARE_PATH,
  compareFormulas,
  savedComparisonPath,
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
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * Recipes side by side as a baker reads them: every flour line together is
 * 100% and the rest is a share of it. The saved columns are the ids in the
 * URL, so a comparison can be sent to someone; the pasted ones live in this
 * browser only, because a recipe copied from a book is research, not a
 * recipe of the kitchen's.
 */

export type CompareView = "formula" | "spec"
export type PastedRecipe = { id: string; title: string; text: string }

/** The saved comparison the page is open on, as the component needs it. */
export type SavedComparisonState = {
  id: string
  publicId: string
  title: string
  editVersion: number
  /** Recipe columns the reader can no longer open. */
  missingCount: number
  /** Pasted columns kept with the record, keyed `saved-<position>`. */
  pasted: PastedRecipe[]
  percentMode: PercentMode
  showGrams: boolean
  overrides: SavedComparisonOverrides
}

/** What a recovered draft carries back onto the page. */
export type ComparisonRecovery = ComparisonDraft

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
            size="icon-compact"
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
        "ml-auto h-7 w-20 px-2 text-right text-md tabular-nums md:text-md"
      )}
    />
  )
}

/** A recipe from anywhere, as text. A name is optional: the first heading
 * of the paste stands in. */
function PasteFormulaDialog({
  open,
  onOpenChange,
  initial = null,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The column being edited; null when pasting a new one. */
  initial?: { title: string; text: string } | null
  onAdd: (title: string, text: string) => void
}) {
  const [title, setTitle] = React.useState("")
  const [text, setText] = React.useState("")
  const [error, setError] = React.useState("")
  // Each opening starts from what it edits, or from nothing.
  React.useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(initial?.title ?? "")
    setText(initial?.text ?? "")
    setError("")
  }, [open, initial])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit pasted recipe" : "Paste a recipe"}
          </DialogTitle>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-md text-destructive">
            {error}
          </p>
        ) : null}
        <div className="grid gap-5">
          <div className="grid gap-2">
            <label
              htmlFor="paste-formula-title"
              className="text-md font-medium"
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
            <label htmlFor="paste-formula-text" className="text-md font-medium">
              Ingredients
            </label>
            <Textarea
              id="paste-formula-text"
              className="min-h-64 bg-card"
              value={text}
              placeholder={"500 g bread flour\n2 cups water\n10 g salt"}
              onChange={(event) => setText(event.target.value)}
            />
            <p className="text-md leading-5 text-muted-foreground">
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
              onOpenChange(false)
            }}
          >
            {initial ? "Save" : "Add"}
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
  savedId = null,
}: {
  selected: string[]
  view: CompareView
  baseId: string | null
  savedId?: string | null
}): string {
  // A saved comparison has its own address; a new one is worked on at /new.
  const path = savedId ? savedComparisonPath(savedId) : COMPARE_NEW_PATH
  const parts: string[] = []
  if (selected.length) {
    parts.push(`r=${selected.map(encodeURIComponent).join(",")}`)
  }
  parts.push(`view=${view}`)
  if (baseId) parts.push(`base=${encodeURIComponent(baseId)}`)
  // The recovery draft of an unsaved comparison rides in `?draft=`; a move
  // between columns must not shake it off. A saved one keeps its own copy
  // under its id and carries none.
  const draft =
    typeof window === "undefined" || savedId
      ? null
      : new URLSearchParams(window.location.search).get("draft")
  if (draft) parts.push(`draft=${encodeURIComponent(draft)}`)
  return `${path}?${parts.join("&")}`
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
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery("")
      }}
    >
      {/* The black primary at the toolbar's end, as the recipes list has it. */}
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button type="button" pending={pending} className={className} />
        }
      >
        + Add recipe
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-64 p-0">
        <PopoverTitle className="sr-only">Add recipe</PopoverTitle>
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
            <span className="flex h-9 shrink-0 items-center px-2.5 text-md text-muted-foreground">
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
                <span className="min-w-0 flex-1 truncate text-md">
                  {option.title}
                </span>
                {option.category ? (
                  <span className="max-w-20 truncate text-md text-muted-foreground">
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
            className="mt-1 flex min-h-9 w-full items-center gap-2.5 rounded-md border-t border-border px-2.5 py-1.5 text-left text-md outline-none hover:bg-accent focus-visible:bg-accent"
          >
            <ClipboardPaste
              className="size-4"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Paste a recipe
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * A column's name: press it to make that recipe the baseline, press again
 * to clear; the X takes the column off the page.
 */
function ColumnHeader({
  formula,
  index,
  baseId,
  pending,
  busy,
  onToggleBase,
  onEdit,
  onRemove,
}: {
  formula: Formula
  index: number
  baseId: string | null
  pending: boolean
  busy: string | null
  onToggleBase: (formula: Formula) => void
  /** Reopens a pasted column's text; saved recipes are edited on their page. */
  onEdit: (formula: Formula) => void
  onRemove: (formula: Formula) => void
}) {
  const active = formula.key === baseId
  return (
    <span className="flex min-w-0 items-center justify-end gap-0.5">
      <button
        type="button"
        aria-pressed={active}
        aria-label={active ? `${formula.title} baseline` : formula.title}
        title={
          active ? "Baseline. Click to clear." : "Click to use as baseline"
        }
        onClick={() => onToggleBase(formula)}
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 outline-none hover:bg-accent focus-visible:bg-accent",
          active && "bg-muted"
        )}
      >
        <span
          className={cn(
            "size-[7px] shrink-0 rounded-full",
            COLUMN_COLORS[index]?.dot
          )}
          aria-hidden="true"
        />
        <span
          className={cn(
            "min-w-0 truncate text-md font-medium",
            active ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {formula.title}
        </span>
      </button>
      {formula.source === "pasted" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-compact"
          aria-label={`Edit ${formula.title}`}
          onClick={() => onEdit(formula)}
          className="shrink-0"
        >
          <SquarePen strokeWidth={1.8} aria-hidden="true" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-compact"
        aria-label={`Remove ${formula.title}`}
        pending={pending && busy === `remove:${formula.key}`}
        onClick={() => onRemove(formula)}
        className="shrink-0"
      >
        <X strokeWidth={2} aria-hidden="true" />
      </Button>
    </span>
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
    return <span className="text-md text-muted-foreground">Not food</span>
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
          <span className="text-md text-muted-foreground">
            Recipe says {value.line.written}
          </span>
        ) : null}
      </div>
    )
  }
  if (value.percent === null) {
    return <span className={cn("text-muted-foreground", className)}>—</span>
  }
  if (baseline !== null) {
    if (isBaseline) {
      return (
        <span className={cn("text-muted-foreground tabular-nums", className)}>
          {formatComparePercent(value.percent)}
        </span>
      )
    }
    return (
      <span className={cn("tabular-nums", className)}>
        {formatCompareDeltaPoints(value.percent - baseline)}
        <span className="block text-md font-normal text-muted-foreground">
          {formatComparePercent(value.percent)}
        </span>
      </span>
    )
  }
  return (
    <span className={cn("tabular-nums", className)}>
      {formatComparePercent(value.percent)}
      {showGrams && value.grams !== null ? (
        <span className="block text-md font-normal text-muted-foreground">
          {formatCompareGrams(value.grams)}
        </span>
      ) : null}
      {value.line?.note === "discarded" ? (
        <span className="block text-md font-normal text-muted-foreground">
          discarded
        </span>
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
    <div className="relative mx-1.5 h-full">
      {/* The guide the dots sit on, with a tick at 0, half and the end so a
          dot's place reads without looking up at the header. The 6px inset
          on each side keeps a dot at 0 or at the end whole; the header
          ticks carry the same inset. */}
      <span
        className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-border"
        aria-hidden="true"
      />
      {["left-0", "left-1/2", "right-0"].map((side) => (
        <span
          key={side}
          className={cn("absolute inset-y-3 w-px bg-border", side)}
          aria-hidden="true"
        />
      ))}
      {stats.min !== null && stats.max !== null && stats.spread > 0.05 ? (
        <span
          className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-line-strong"
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
  onSetRole,
  onSetGrams,
  pending,
  busy,
  onToggleBase,
  onEdit,
  onRemove,
  canLink,
  onLink,
}: {
  columns: Formula[]
  groups: ComparisonGroup[]
  baseId: string | null
  mode: PercentMode
  showGrams: boolean
  expanded: Record<string, boolean>
  gramOverrides: Record<string, number>
  onExpandedChange: (role: FormulaRole) => void
  onSetRole: (rowKey: string, role: FormulaRole) => void
  onSetGrams: (formulaKey: string, lineId: string, grams: number | null) => void
  pending: boolean
  busy: string | null
  onToggleBase: (formula: Formula) => void
  onEdit: (formula: Formula) => void
  onRemove: (formula: Formula) => void
  /** Whether this reader may link a pasted line to the pantry. */
  canLink: boolean
  onLink: (row: PlotRow) => void
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
        {/* Every column is a set width and the table is no wider than its
            columns, so a dot's place on the axis does not shift when a
            recipe is added or the window changes. */}
        <Table className="w-auto">
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
              <TableHead className="w-[400px] max-w-[400px] min-w-[400px] align-middle">
                <div className="relative mx-1.5 h-11">
                  {axisTicks.map((tick, index) => (
                    <span
                      key={tick}
                      className={cn(
                        "absolute top-1/2 -translate-y-1/2 text-xs text-muted-foreground",
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
                  className="w-[136px] min-w-[136px] text-right align-middle"
                >
                  <ColumnHeader
                    formula={formula}
                    index={index}
                    baseId={baseId}
                    pending={pending}
                    busy={busy}
                    onToggleBase={onToggleBase}
                    onEdit={onEdit}
                    onRemove={onRemove}
                  />
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
                  canLink={canLink}
                  onLink={onLink}
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
                        canLink={canLink}
                        onLink={onLink}
                      />
                    ))
                  : null}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </TableFrame>
      <div className="mt-3.5 flex flex-col gap-2 text-md text-muted-foreground md:flex-row md:items-center">
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
  canLink,
  onLink,
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
  canLink: boolean
  onLink: (row: PlotRow) => void
}) {
  const canExpand = row.kind === "group" && row.group.rows.length > 1
  // Which columns hold this line with no profile behind it: a pasted one
  // can be linked here; a saved recipe's link lives on the recipe.
  const unmappedIn = columns.filter((formula, index) => {
    const line = row.values[index]?.line
    return Boolean(line && !line.mapped && line.note !== "nonEdible")
  })
  const unmappedPasted = unmappedIn.some((one) => one.source === "pasted")
  const unmappedSaved = unmappedIn.find((one) => one.source === "saved")
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
            <span className="min-w-0">
              <span className="block truncate text-md font-semibold text-foreground">
                {row.label}
              </span>
              {note ? (
                <span className="block text-md text-muted-foreground">
                  Hydration
                </span>
              ) : null}
            </span>
            <ChevronDown
              className={cn(
                "size-3 shrink-0 text-muted-foreground",
                expanded && "rotate-180"
              )}
              strokeWidth={2}
              aria-hidden="true"
            />
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
                    : "text-md text-muted-foreground"
                )}
              >
                {row.label}
              </span>
              {row.kind === "group" && note ? (
                <span className="block text-md text-muted-foreground">
                  Hydration
                </span>
              ) : null}
              {unmappedIn.length > 0 &&
              (row.kind === "ingredient" || row.group.rows.length === 1) ? (
                <span className="flex items-center gap-1.5 text-md text-muted-foreground">
                  No profile
                  {unmappedPasted && canLink ? (
                    <button
                      type="button"
                      onClick={() => onLink(row)}
                      className={cn(
                        "inline-flex items-center gap-1",
                        linkClassName
                      )}
                    >
                      <Link2
                        className="size-3"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                      Link to ingredient
                    </button>
                  ) : null}
                  {unmappedSaved?.href ? (
                    <GuardedLink
                      href={unmappedSaved.href}
                      className={linkClassName}
                    >
                      Link on the recipe
                    </GuardedLink>
                  ) : null}
                </span>
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
      <TableCell className="w-[400px] max-w-[400px] min-w-[400px]">
        <div className={row.kind === "group" ? "h-14" : "h-10"}>
          <DotPlot row={row} columns={columns} axisMax={axisMax} />
        </div>
      </TableCell>
      {columns.map((formula, index) => (
        <TableCell
          key={formula.key}
          className={cn(
            "w-[136px] min-w-[136px] text-right",
            row.kind === "group"
              ? "text-md font-medium text-foreground"
              : "text-md text-muted-foreground"
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

/* ----------------------------------------------------------------------- */
/* Spec sheet: what comes out                                               */
/* ----------------------------------------------------------------------- */

type SpecFigureKey =
  "hydration" | "water" | "fat" | "sugar" | "protein" | "salt" | "solids"

const SPEC_FIGURES: readonly SpecFigureKey[] = [
  "hydration",
  "water",
  "fat",
  "sugar",
  "protein",
  "salt",
  "solids",
]

function specFigureLabel(key: SpecFigureKey, mode: PercentMode): string {
  switch (key) {
    case "hydration":
      return mode === "bakers" ? "Hydration" : "Liquids"
    case "water":
      return "Total water"
    case "fat":
      return "Fat"
    case "sugar":
      return "Sugars"
    case "protein":
      return "Protein"
    case "salt":
      return "Salt"
    case "solids":
      return "Total solids"
  }
}

/**
 * A composition figure on the column's basis: flour in baker's mode, the
 * whole dough in weight mode. Solids are always a share of the weight the
 * profiles cover, since "solids of flour" means nothing.
 */
export function specFigure(
  formula: Formula,
  key: SpecFigureKey,
  mode: PercentMode
): number | null {
  if (key === "solids") return formula.summary.solidsPercent
  const basis = mode === "bakers" ? formula.basisGrams : formula.totalGrams
  if (basis <= 0) return null
  const grams = formula.summary.grams[key === "hydration" ? "liquid" : key]
  return Math.round((grams / basis) * 1000) / 10
}

/** The lines no profile describes, by name, so the gap can be closed. */
function unmappedLabels(formula: Formula): string[] {
  return formula.lines
    .filter((line) => !line.mapped && line.note !== "nonEdible")
    .map((line) => line.label)
}

function coverageLine(formula: Formula): string {
  const covered = `Profiles cover ${formatComparePercent(formula.summary.coveragePercent)} of the weight`
  const names = unmappedLabels(formula)
  return names.length > 0
    ? `${covered} · unmapped: ${names.join(", ")}`
    : covered
}

function SpecSheetView({
  columns,
  baseId,
  mode,
  pending,
  busy,
  onToggleBase,
  onEdit,
  onRemove,
}: {
  columns: Formula[]
  baseId: string | null
  mode: PercentMode
  pending: boolean
  busy: string | null
  onToggleBase: (formula: Formula) => void
  onEdit: (formula: Formula) => void
  onRemove: (formula: Formula) => void
}) {
  const baseIndex = columns.findIndex((formula) => formula.key === baseId)
  const figures = SPEC_FIGURES.map((key) => {
    const values = columns.map((formula) => specFigure(formula, key, mode))
    return {
      key,
      values,
      rowMax: compareRowStats(values).max,
      baseline: baseIndex >= 0 ? (values[baseIndex] ?? null) : null,
    }
  })
  return (
    <div className="overflow-x-auto">
      <div
        className={cn(
          "grid min-w-full gap-8",
          SPEC_GRID_CLASSES[columns.length] ?? SPEC_GRID_CLASSES[4]
        )}
      >
        {columns.map((formula, index) => {
          const isBaseline = formula.key === baseId
          const partial = formula.summary.coveragePercent < 100
          return (
            <div key={formula.key} className="min-w-0">
              <div className="pb-[22px]">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "size-[9px] shrink-0 rounded-full",
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
                  {formula.source === "pasted" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-compact"
                      aria-label={`Edit ${formula.title}`}
                      onClick={() => onEdit(formula)}
                      className="ml-auto shrink-0"
                    >
                      <SquarePen strokeWidth={1.8} aria-hidden="true" />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-compact"
                    aria-label={`Remove ${formula.title}`}
                    pending={pending && busy === `remove:${formula.key}`}
                    onClick={() => onRemove(formula)}
                    className={cn(
                      "shrink-0",
                      formula.source === "pasted" ? "" : "ml-auto"
                    )}
                  >
                    <X strokeWidth={2} aria-hidden="true" />
                  </Button>
                </div>
                <p className="mt-1 flex items-center gap-2 text-md text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {formula.source === "pasted"
                      ? "Pasted recipe"
                      : (formula.category ?? "")}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={isBaseline}
                    onClick={() => onToggleBase(formula)}
                    className={cn(
                      "shrink-0",
                      isBaseline && "bg-muted text-foreground"
                    )}
                  >
                    {isBaseline ? "Baseline" : "Use as baseline"}
                  </Button>
                </p>
                {basisNote(formula) ? (
                  <p className="mt-1 text-md text-muted-foreground">
                    {basisNote(formula)}
                  </p>
                ) : null}
                <p className="mt-1 text-md text-muted-foreground">
                  {formatCompareGrams(formula.roleTotals.flour.grams)} flour ·{" "}
                  {formatCompareGrams(formula.totalGrams)} dough
                </p>
                {/* The figures below are only as good as the profile links,
                    so a gap is said up here, not in a footnote. */}
                <p
                  className={cn(
                    "mt-1 text-md",
                    partial
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  {coverageLine(formula)}
                </p>
              </div>
              {figures.map((figure) => {
                const value = figure.values[index] ?? null
                const delta =
                  baseId &&
                  !isBaseline &&
                  value !== null &&
                  figure.baseline !== null
                    ? Math.round((value - figure.baseline) * 10) / 10
                    : null
                const width =
                  value !== null && figure.rowMax !== null && figure.rowMax > 0
                    ? Math.min(100, (value / figure.rowMax) * 100)
                    : 0
                return (
                  <section
                    key={figure.key}
                    className="border-t border-border pt-4 pb-[18px]"
                  >
                    <h3 className="text-md font-medium text-muted-foreground">
                      {specFigureLabel(figure.key, mode)}
                      {figure.key === "solids" ? (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · of covered weight
                        </span>
                      ) : null}
                    </h3>
                    <div className="mt-1 flex items-baseline gap-2">
                      {value === null ? (
                        <>
                          <span className="text-2xl font-semibold text-muted-foreground">
                            —
                          </span>
                          <span className="text-md text-muted-foreground">
                            Nothing weighed
                          </span>
                        </>
                      ) : (
                        <>
                          <span
                            className={cn(
                              "font-semibold tracking-tight text-foreground tabular-nums",
                              figure.key === "hydration"
                                ? "text-2xl"
                                : "text-2xl"
                            )}
                          >
                            {formatComparePercent(value)}
                          </span>
                          {delta !== null ? (
                            <span className="text-md font-medium text-muted-foreground tabular-nums">
                              {formatCompareDeltaPoints(delta)}
                            </span>
                          ) : null}
                        </>
                      )}
                    </div>
                    <div className="mt-2 h-1 w-full rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-1 rounded-full",
                          COLUMN_COLORS[index]?.fill
                        )}
                        style={{ width: `${width}%` }}
                        aria-hidden="true"
                      />
                    </div>
                  </section>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
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
  saved = null,
  currentUserId,
  lineMatches = [],
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
  /** The saved comparison the page is open on, if any. */
  saved?: SavedComparisonState | null
  /** The account editing, which owns the record and its recovery draft. */
  currentUserId: string
  /** The kitchen's saved line spellings; empty where the pantry is not the reader's. */
  lineMatches?: LineMatchRow[]
}) {
  const { go } = useGuardedNavigate()
  const router = useRouter()
  const { refresh } = useRefresh()
  // Moving between columns, views and baselines rewrites this page's own
  // address; it is not leaving, so it must not run the leave guard.
  const [pending, startMove] = React.useTransition()
  const toast = useToast()
  const { saveRef, setDirty, setSaveState } = useCompareEdit()
  // Everything below is the record: it starts as what was saved and is
  // written back whole. A new comparison starts empty.
  const [title, setTitle] = React.useState(saved?.title ?? "")
  const [titleMissing, setTitleMissing] = React.useState(false)
  const titleRef = React.useRef<HTMLInputElement>(null)
  const [mode, setMode] = React.useState<PercentMode>(
    saved?.percentMode ?? "bakers"
  )
  const [pasted, setPasted] = React.useState<PastedRecipe[]>(
    () => saved?.pasted ?? []
  )
  const [recordId, setRecordId] = React.useState<string | null>(
    saved?.id ?? null
  )
  const [showGrams, setShowGrams] = React.useState(saved?.showGrams ?? false)
  const [gramOverrides, setGramOverrides] = React.useState<
    Record<string, number>
  >(() => ({ ...(saved?.overrides.grams ?? {}) }))
  const [roleOverrides, setRoleOverrides] = React.useState<
    Record<string, FormulaRole>
  >(
    () => ({ ...(saved?.overrides.roles ?? {}) }) as Record<string, FormulaRole>
  )
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})
  const [pasteOpen, setPasteOpen] = React.useState(false)
  // The pasted column the dialog is editing, or null when pasting a new one.
  const [pasteEditing, setPasteEditing] = React.useState<string | null>(null)
  // What the kitchen says a spelling is, plus what was linked on this page.
  const [matches, setMatches] = React.useState<RecipeLineMatch[]>(() =>
    lineMatches.map((one) => ({
      line: one.line,
      targetId: one.targetId,
      targetName: one.targetName,
      targetKind: one.targetKind,
    }))
  )
  // The row whose line is being linked to the pantry, if any.
  const [linkRow, setLinkRow] = React.useState<PlotRow | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deletePending, startDelete] = React.useTransition()
  // The control whose press started the navigation, so its wait shows there.
  const [busy, setBusy] = React.useState<string | null>(null)

  const pastedInputs = React.useMemo(
    () =>
      pasted.map((one) =>
        pastedFormulaInput(
          `paste:${one.id}`,
          one.title,
          one.text,
          identities,
          matches
        )
      ),
    [pasted, identities, matches]
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
    const href = compareUrl({
      selected: next.selected ?? selected,
      view: next.view ?? view,
      baseId: next.baseId === undefined ? selectedBase : next.baseId,
      savedId: saved?.publicId ?? null,
    })
    startMove(() => router.replace(href))
  }

  // What the record holds: the columns in the order they read, which one
  // is the baseline, by position, and how the page read them.
  const baselinePosition = selectedBase
    ? (() => {
        const at = columns.findIndex((one) => one.key === selectedBase)
        return at >= 0 ? at : null
      })()
    : null
  const columnPayload = () =>
    columns.map((formula) => {
      if (formula.source === "saved") return { recipeId: formula.key }
      const one = pasted.find((entry) => `paste:${entry.id}` === formula.key)
      return { pastedTitle: one?.title ?? "", pastedText: one?.text ?? "" }
    })
  const overridesPayload = (): SavedComparisonOverrides => ({
    grams: Object.fromEntries(
      Object.entries(gramOverrides).sort(([a], [b]) => a.localeCompare(b))
    ),
    roles: Object.fromEntries(
      Object.entries(roleOverrides).sort(([a], [b]) => a.localeCompare(b))
    ),
  })
  // Normalized so that adopting what the server stored does not re-dirty
  // the screen; nothing here is a key, an id or a server timestamp.
  const snapshot = JSON.stringify([
    title.trim(),
    view,
    mode,
    showGrams,
    baselinePosition,
    columnPayload(),
    overridesPayload(),
  ])

  const save = async (
    expectedEditVersion: number | null,
    leaving: boolean
  ): Promise<SaveEcho | SaveFailure> => {
    if (!title.trim()) {
      setTitleMissing(true)
      toast.add({ title: "Give the comparison a name", type: "error" })
      titleRef.current?.focus()
      return { kind: "validation", message: "Give the comparison a name" }
    }
    if (columns.length === 0) {
      toast.add({ title: "Add a recipe to compare first", type: "error" })
      return {
        kind: "validation",
        message: "Add a recipe to compare first",
      }
    }
    const creating = recordId === null
    const payload: SaveComparisonInput = {
      id: recordId,
      ...(expectedEditVersion === null ? {} : { expectedEditVersion }),
      title: title.trim(),
      view,
      baselinePosition,
      percentMode: mode,
      showGrams,
      overrides: overridesPayload(),
      columns: columnPayload(),
    }
    const result = await saveComparison(payload)
    if ("error" in result) return toSaveFailure(result)
    setRecordId(result.id)
    // Leaving: rewrite the entry being left, never navigate.
    if (leaving) {
      if (creating) {
        window.history.replaceState(
          null,
          "",
          compareUrl({
            selected,
            view,
            baseId: selectedBase,
            savedId: result.publicId,
          })
        )
      }
      return { editVersion: result.editVersion }
    }
    if (creating) {
      void go(
        compareUrl({
          selected,
          view,
          baseId: selectedBase,
          savedId: result.publicId,
        }),
        { replace: true, force: true }
      )
    }
    return {
      editVersion: result.editVersion,
      adopt: () => setTitle(result.title),
    }
  }

  const { saveNow, conflict, restorable, dismissRestore, discardDraft } =
    useDocumentSave({
      snapshot,
      // A comparison saves when the cook asks, or on the way off the page.
      active: false,
      wholeForm: true,
      kind: "comparison",
      workspaceId: currentUserId,
      userId: currentUserId,
      recordId,
      editVersion: saved?.editVersion ?? null,
      payload: () =>
        comparisonDraft({
          title,
          view,
          percentMode: mode,
          showGrams,
          baselineKey: selectedBase,
          recipeIds: selected,
          pasted,
          overrides: overridesPayload(),
        }),
      setDirty,
      setSaveState,
      save,
    })

  const report = (failure: SaveFailure | null) => {
    if (!failure) {
      toast.add({ title: "Comparison saved" })
      return
    }
    // A validation failure has already named what stopped it.
    if (failure.kind === "validation") return
    toast.add({
      title: "Couldn’t save",
      description: failure.message,
      type: "error",
    })
  }
  /** The same save, out loud: the header's Save button and Cmd+S. */
  const saveOnRequest = async () => report(await saveNow())
  // The Save button lives in the chrome, above this screen; it calls this.
  React.useEffect(() => {
    saveRef.current = saveOnRequest
    return () => {
      saveRef.current = null
    }
  })

  const applyRecovery = (draft: ComparisonRecovery) => {
    setTitle(draft.title)
    setMode(draft.percentMode === "weight" ? "weight" : "bakers")
    setShowGrams(draft.showGrams)
    setPasted(
      draft.pasted.map((one) => ({
        id: one.id,
        title: one.title,
        text: one.text,
      }))
    )
    setGramOverrides({ ...draft.overrides.grams })
    setRoleOverrides({ ...draft.overrides.roles } as Record<
      string,
      FormulaRole
    >)
    navigate({
      selected: [...draft.recipeIds],
      view: draft.view === "spec" ? "spec" : "formula",
      baseId: draft.baselineKey,
    })
  }

  const confirmDelete = () => {
    if (!saved) return
    startDelete(async () => {
      const result = await deleteComparison(saved.id)
      if ("error" in result) {
        toast.add({ title: result.error, type: "error" })
        return
      }
      startDelete(() => {
        setDeleteOpen(false)
        // Nothing left to keep: the guard must not ask on the way out.
        setDirty(false)
        toast.add({ title: `Deleted ${saved.title}` })
        void go(COMPARE_PATH, { replace: true, force: true })
      })
    })
  }

  const addRecipe = (publicId: string) => {
    setBusy("add")
    navigate({ selected: [...selected, publicId] })
  }
  const remove = (formula: Formula) => {
    if (formula.source === "pasted") {
      setPasted(pasted.filter((one) => `paste:${one.id}` !== formula.key))
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
  const toggleBase = (formula: Formula) =>
    navigate({ baseId: selectedBase === formula.key ? null : formula.key })
  const addPasted = (name: string, text: string) => {
    if (pasteEditing) {
      const key = `paste:${pasteEditing}`
      setPasted(
        pasted.map((one) =>
          one.id === pasteEditing
            ? { ...one, title: name || one.title, text }
            : one
        )
      )
      // New text means new lines; grams typed for the old ones are gone.
      setGramOverrides((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([k]) => !k.startsWith(`${key}|`))
        )
      )
      setPasteEditing(null)
      return
    }
    const id = crypto.randomUUID()
    setPasted([
      ...pasted,
      { id, title: name || `Pasted recipe ${pasted.length + 1}`, text },
    ])
  }
  // A link is the kitchen's, saved by the dialog; the page reads it at
  // once and re-reads the pantry, in case the ingredient is new.
  const linked = (match: PriceLineMatch) => {
    setMatches((current) => [
      ...current.filter((one) => one.line !== match.line),
      {
        line: match.line,
        targetId: match.entry.id,
        targetName: match.entry.name,
        measureName: match.entry.measureName,
        targetKind: "ingredient",
      },
    ])
    void refresh()
  }
  const editPasted = (formula: Formula) => {
    setPasteEditing(formula.key.replace(/^paste:/, ""))
    setPasteOpen(true)
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
  const chooseMode = (next: PercentMode) => setMode(next)
  const toggleGrams = () => setShowGrams((current) => !current)

  const pasteButton = (
    <Button
      type="button"
      variant="outline"
      disabled={full}
      onClick={() => setPasteOpen(true)}
    >
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
      {conflict ? (
        <NoticeBanner
          tone="warning"
          action={
            <NoticeBannerActions>
              <NoticeBannerAction
                type="button"
                onClick={() => window.location.reload()}
              >
                Reload
              </NoticeBannerAction>
              <NoticeBannerAction
                type="button"
                onClick={() => {
                  discardDraft()
                  window.location.reload()
                }}
              >
                Discard my changes
              </NoticeBannerAction>
            </NoticeBannerActions>
          }
        >
          {conflict.message}
        </NoticeBanner>
      ) : restorable ? (
        <NoticeBanner
          tone="info"
          action={
            <NoticeBannerActions>
              <NoticeBannerAction
                type="button"
                onClick={() => {
                  applyRecovery(restorable as ComparisonRecovery)
                  dismissRestore()
                }}
              >
                Restore
              </NoticeBannerAction>
              <NoticeBannerAction type="button" onClick={discardDraft}>
                Discard
              </NoticeBannerAction>
            </NoticeBannerActions>
          }
        >
          This device kept changes that never reached the server.
        </NoticeBanner>
      ) : null}
      {/* The name comes first and is always there: it is what the header's
          Save asks for, columns or no columns. */}
      <LabeledInput
        ref={titleRef}
        label="Name (required)"
        value={title}
        maxLength={120}
        aria-invalid={titleMissing || undefined}
        onChange={(event) => {
          setTitle(event.target.value)
          if (event.target.value.trim()) setTitleMissing(false)
        }}
        className="mb-7"
      />
      {/* The band the recipe and product editors put between sections. */}
      <div className="border-t-[6px] border-secondary pt-7" />
      {columns.length === 0 ? (
        <EmptyState
          title="Compare recipes as baker's percentages"
          description="Add recipes from your list to read them side by side, or paste a recipe from anywhere to read it beside one of yours, or on its own. Save the comparison by name to find it again on the Compare list."
        >
          {pasteButton}
          {addPopover}
        </EmptyState>
      ) : (
        <>
          <Toolbar>
            {/* On a phone the toolbar stacks; these rows keep the controls at
                their own width instead of stretching across the screen. */}
            <div className="flex flex-wrap items-center gap-2 md:contents">
              <TabPills>
                <TabPill
                  active={view === "formula"}
                  onClick={() => navigate({ view: "formula" })}
                >
                  Formula
                </TabPill>
                <TabPill
                  active={view === "spec"}
                  onClick={() => navigate({ view: "spec" })}
                >
                  Spec sheet
                </TabPill>
              </TabPills>
            </div>
            <ToolbarSpacer />
            <div className="flex flex-wrap items-center gap-2 md:contents">
              {pasteButton}
              <ActionsMenu>
                {/* The one command first, with its icon; the check items
                    that pick a value follow. */}
                {saved ? (
                  <MenuItem
                    onClick={() => setDeleteOpen(true)}
                    className="text-destructive data-highlighted:text-destructive"
                  >
                    <Trash2 strokeWidth={1.8} aria-hidden="true" />
                    Delete
                  </MenuItem>
                ) : null}
                {MODE_OPTIONS.map((option) => (
                  <MenuCheckItem
                    key={option.value}
                    checked={mode === option.value}
                    onClick={() => chooseMode(option.value)}
                  >
                    {option.label}
                  </MenuCheckItem>
                ))}
                <MenuCheckItem checked={showGrams} onClick={toggleGrams}>
                  Show weights
                </MenuCheckItem>
              </ActionsMenu>
              {addPopover}
            </div>
          </Toolbar>
          {missingCount > 0 ? (
            <p className="mb-4 text-md text-muted-foreground">
              {plural(missingCount, "selected recipe")} could not be opened.
            </p>
          ) : null}
          {view === "spec" ? (
            <SpecSheetView
              columns={columns}
              baseId={selectedBase}
              mode={mode}
              pending={pending}
              busy={busy}
              onToggleBase={toggleBase}
              onEdit={editPasted}
              onRemove={remove}
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
              onSetRole={setRole}
              onSetGrams={setGrams}
              pending={pending}
              busy={busy}
              onToggleBase={toggleBase}
              onEdit={editPasted}
              onRemove={remove}
              canLink={identities.length > 0}
              onLink={setLinkRow}
            />
          )}
        </>
      )}
      {linkRow ? (
        <PriceLineDialog
          lineName={linkRow.label}
          priceList={identities}
          trigger={null}
          open
          onOpenChange={(open) => {
            if (!open) setLinkRow(null)
          }}
          onLinked={(match) => {
            linked(match)
            setLinkRow(null)
          }}
        />
      ) : null}
      {columns.length === 0 && missingCount > 0 ? (
        <p className="mt-3 text-md text-muted-foreground">
          {plural(missingCount, "selected recipe")} could not be opened.
        </p>
      ) : null}
      <PasteFormulaDialog
        open={pasteOpen}
        onOpenChange={(open) => {
          setPasteOpen(open)
          if (!open) setPasteEditing(null)
        }}
        initial={
          pasteEditing
            ? (pasted.find((one) => one.id === pasteEditing) ?? null)
            : null
        }
        onAdd={addPasted}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !deletePending) setDeleteOpen(false)
        }}
        title="Delete this comparison?"
        description={`${saved?.title ?? "This comparison"} is removed. The recipes are untouched.`}
        confirmLabel={deletePending ? "Deleting…" : "Delete comparison"}
        pending={deletePending}
        onConfirm={confirmDelete}
      />
    </>
  )
}
