"use client"

import * as React from "react"
import { ChevronDown, ClipboardPaste, X } from "lucide-react"

import {
  GuardedLink,
  useGuardedNavigate,
} from "@/components/navigation-blocker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FilterPill } from "@/components/ui/filter-pill"
import { Input } from "@/components/ui/input"
import {
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuTrigger,
} from "@/components/ui/menu"
import { EmptyState, Toolbar, ToolbarSpacer } from "@/components/ui/page"
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
  compareFormulas,
  compareHref,
  FORMULA_ROLE_LABELS,
  FORMULA_ROLES,
  gramOverrideKey,
  MAX_COMPARE_RECIPES,
  pastedFormulaInput,
  type Formula,
  type FormulaInput,
  type FormulaLine,
  type FormulaOverrides,
  type FormulaRole,
  type PercentMode,
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

/** This browser's last choice of denominator. Its own key: the editor's
 * `recipe.percentageMode` divides raw quantities by one base line, which is
 * a different reading, and one screen must not silently flip the other. */
export const COMPARE_MODE_KEY = "recipe.compare.percentMode"
/** The recipes pasted here, as text: identities differ between visits, so
 * they are read again on every load. */
export const COMPARE_PASTED_KEY = "recipe.compare.pasted"

export type PastedRecipe = { id: string; title: string; text: string }

const MODE_OPTIONS: Array<{ value: PercentMode; label: string }> = [
  { value: "bakers", label: "Baker’s %" },
  { value: "weight", label: "Weight %" },
]

const SUMMARY_ROWS: Array<{
  key: "hydration" | "water" | "fat" | "sugar" | "protein" | "salt"
  label: string
}> = [
  { key: "hydration", label: "Hydration" },
  { key: "water", label: "Water" },
  { key: "fat", label: "Fat" },
  { key: "sugar", label: "Sugar" },
  { key: "protein", label: "Protein" },
  { key: "salt", label: "Salt" },
]

const gramsFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })

function formatGrams(grams: number): string {
  return gramsFormat.format(grams)
}

function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${percent.toFixed(1)}%`
}

/** Signed points, a proper minus, and a flat zero under half a point. */
function formatDelta(delta: number | null): string {
  if (delta === null) return "—"
  if (Math.abs(delta) < 0.05) return "0.0"
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}`
}

function pointsDelta(
  count: number,
  first: number | null | undefined,
  second: number | null | undefined
): number | null {
  if (count !== 2 || first == null || second == null) return null
  return Math.round((second - first) * 10) / 10
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
    <Input
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
      className="ml-auto h-7 w-20 px-2 text-right text-sm tabular-nums md:text-sm"
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
            <Input
              id="paste-formula-title"
              autoFocus
              maxLength={120}
              value={title}
              placeholder="Serious Eats focaccia"
              onChange={(event) => setTitle(event.target.value)}
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

function basisNote(formula: Formula, mode: PercentMode): string | null {
  if (mode !== "bakers") return null
  if (formula.basis === "base" || formula.basis === "heaviest") {
    return `${formula.title}: no flour line, so percentages are of ${formula.basisLabel}.`
  }
  if (formula.basis === "none") {
    return `${formula.title}: nothing weighed yet, so there are no percentages.`
  }
  return null
}

export function CompareFormulas({
  selected,
  formulas,
  missingCount,
  identities,
  recipeOptions,
}: {
  /** The saved recipes in the URL, in order. */
  selected: string[]
  formulas: FormulaInput[]
  /** Ids in the URL that could not be opened. */
  missingCount: number
  /** The pantry, for weighing pasted lines; empty where cost is not the reader's. */
  identities: PriceListEntry[]
  recipeOptions: Array<{ publicId: string; title: string }>
}) {
  const { go, pending } = useGuardedNavigate()
  const [mode, setMode] = React.useState<PercentMode>("bakers")
  const [pasted, setPasted] = React.useState<PastedRecipe[]>([])
  const [gramOverrides, setGramOverrides] = React.useState<
    Record<string, number>
  >({})
  const [roleOverrides, setRoleOverrides] = React.useState<
    Record<string, FormulaRole>
  >({})
  const [pasteOpen, setPasteOpen] = React.useState(false)
  // The control whose press started the navigation, so its wait shows there.
  const [busy, setBusy] = React.useState<string | null>(null)
  const [scrolled, setScrolled] = React.useState(false)

  // This browser's last choices. Read after mount: the server cannot know
  // what this browser prefers or has pasted.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(
      window.localStorage.getItem(COMPARE_MODE_KEY) === "weight"
        ? "weight"
        : "bakers"
    )
    setPasted(readPasted())
  }, [])

  const chooseMode = (next: PercentMode) => {
    setMode(next)
    window.localStorage.setItem(COMPARE_MODE_KEY, next)
  }
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
  const count = columns.length
  const full = count >= MAX_COMPARE_RECIPES
  const twoColumns = count === 2
  const span = 1 + count * 2 + (twoColumns ? 1 : 0)

  const addRecipe = (publicId: string) => {
    setBusy("add")
    void go(compareHref([...selected, publicId]), { replace: true })
  }
  const remove = (formula: Formula) => {
    if (formula.source === "pasted") {
      savePasted(pasted.filter((one) => `paste:${one.id}` !== formula.key))
      return
    }
    setBusy(`remove:${formula.key}`)
    void go(compareHref(selected.filter((id) => id !== formula.key)), {
      replace: true,
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

  const addMenu = (
    <Menu>
      <MenuTrigger
        disabled={full}
        render={
          <Button
            variant="outline"
            pending={pending && busy === "add"}
            className="shrink-0"
          />
        }
      >
        Add recipe
        <ChevronDown
          className="size-[13px]"
          strokeWidth={2}
          aria-hidden="true"
        />
      </MenuTrigger>
      <MenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
        {recipeOptions.length === 0 ? (
          <span className="flex h-9 items-center px-2.5 text-base text-faint">
            No recipes yet
          </span>
        ) : (
          recipeOptions.map((option) => {
            const chosen = selected.includes(option.publicId)
            return (
              <MenuCheckItem
                key={option.publicId}
                checked={chosen}
                disabled={chosen}
                onClick={() => addRecipe(option.publicId)}
              >
                <span className="min-w-0 truncate">{option.title}</span>
              </MenuCheckItem>
            )
          })
        )}
      </MenuContent>
    </Menu>
  )
  const pasteButton = (
    <Button type="button" disabled={full} onClick={() => setPasteOpen(true)}>
      <ClipboardPaste strokeWidth={1.8} aria-hidden="true" />
      Paste recipe
    </Button>
  )

  // The name column stays put while the rest scrolls; its hairline only
  // shows once there is something hidden behind it.
  const stickyClass = cn(
    "sticky left-0 z-[1] bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:content-['']",
    scrolled ? "after:bg-border" : "after:bg-transparent"
  )
  const numberCell = "text-right text-base whitespace-nowrap tabular-nums"

  const gramsCell = (formula: Formula, line: FormulaLine) => {
    if (line.note === "nonEdible") {
      return <span className="text-base text-muted-foreground">Not food</span>
    }
    const overrideId =
      line.lineIds.find(
        (id) => gramOverrides[gramOverrideKey(formula.key, id)] !== undefined
      ) ?? line.unweighedLineId
    if (overrideId !== null) {
      return (
        <div className="flex flex-col items-end gap-0.5 py-1.5">
          <GramsInput
            label={line.label}
            column={formula.title}
            value={gramOverrides[gramOverrideKey(formula.key, overrideId)]}
            onCommit={(grams) => setGrams(formula.key, overrideId, grams)}
          />
          {line.written ? (
            <span className="text-2xs text-muted-foreground">
              {line.written}
            </span>
          ) : null}
        </div>
      )
    }
    return (
      <>
        {formatGrams(line.grams ?? 0)}
        {line.note === "discarded" ? (
          <span className="block text-2xs text-muted-foreground">
            discarded
          </span>
        ) : null}
      </>
    )
  }

  const notes = columns
    .map((formula) => basisNote(formula, mode))
    .filter((note): note is string => note !== null)

  return (
    <>
      {count === 0 ? (
        <EmptyState
          title="Compare recipes as baker’s percentages"
          description="Select recipes on the Recipes list and choose Compare from Actions, or paste a recipe from anywhere to read it beside one of yours, or on its own."
        >
          {pasteButton}
          {addMenu}
        </EmptyState>
      ) : (
        <>
          <Toolbar>
            <FilterPill
              label="Show"
              value={mode}
              options={MODE_OPTIONS}
              onSelect={chooseMode}
            />
            <ToolbarSpacer />
            <div className="flex flex-wrap items-center gap-2 md:contents">
              {addMenu}
              {pasteButton}
            </div>
          </Toolbar>

          <TableFrame
            className="overflow-x-auto"
            onScroll={(event) =>
              setScrolled(event.currentTarget.scrollLeft > 0)
            }
          >
            <Table>
              <TableHeader>
                <TableHeaderRow className="h-auto border-b-0">
                  <TableHead
                    rowSpan={2}
                    className={cn(
                      "min-w-[200px] pb-2 align-bottom",
                      stickyClass
                    )}
                  >
                    Ingredient
                  </TableHead>
                  {columns.map((formula) => (
                    <TableHead
                      key={formula.key}
                      colSpan={2}
                      className="min-w-[176px] pt-3 pb-1 align-top whitespace-normal"
                    >
                      <div className="flex items-start gap-1">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex min-w-0 items-center gap-1.5 text-base font-medium text-foreground">
                            {formula.href ? (
                              <GuardedLink
                                href={formula.href}
                                className="min-w-0 truncate hover:underline"
                              >
                                {formula.title}
                              </GuardedLink>
                            ) : (
                              <span className="min-w-0 truncate">
                                {formula.title}
                              </span>
                            )}
                            {formula.source === "pasted" ? (
                              <Badge size="row">Pasted</Badge>
                            ) : null}
                          </span>
                          <span className="text-2xs font-normal text-muted-foreground">
                            {mode === "bakers"
                              ? formula.basis === "flour"
                                ? `100% = ${formula.basisLabel}`
                                : formula.basis === "none"
                                  ? "Nothing weighed"
                                  : `100% = ${formula.basisLabel}`
                              : "Share of total weight"}
                          </span>
                          {formula.summary.unweighedCount > 0 ||
                          formula.skippedCount > 0 ? (
                            <span className="text-2xs font-normal text-muted-foreground">
                              {[
                                formula.summary.unweighedCount > 0
                                  ? `${plural(formula.summary.unweighedCount, "line")} without a weight`
                                  : null,
                                formula.skippedCount > 0
                                  ? `${plural(formula.skippedCount, "line")} not read`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          ) : null}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${formula.title}`}
                          pending={pending && busy === `remove:${formula.key}`}
                          onClick={() => remove(formula)}
                          className="ml-auto shrink-0"
                        >
                          <X strokeWidth={2} aria-hidden="true" />
                        </Button>
                      </div>
                    </TableHead>
                  ))}
                  {twoColumns ? (
                    <TableHead
                      rowSpan={2}
                      className="w-20 pb-2 text-right align-bottom"
                    >
                      Δ pts
                    </TableHead>
                  ) : null}
                </TableHeaderRow>
                <TableHeaderRow className="h-8">
                  {columns.map((formula) => (
                    <React.Fragment key={formula.key}>
                      <TableHead className="w-24 text-right">g</TableHead>
                      <TableHead className="w-20 text-right">%</TableHead>
                    </React.Fragment>
                  ))}
                </TableHeaderRow>
              </TableHeader>
              <TableBody>
                {comparison.groups.map((group) => (
                  <React.Fragment key={group.role}>
                    <TableRow className="h-9 hover:bg-transparent">
                      <TableCell
                        className={cn(
                          "pt-3 text-2xs font-medium text-ink-soft",
                          stickyClass
                        )}
                      >
                        {group.label}
                      </TableCell>
                      <TableCell colSpan={span - 1} />
                    </TableRow>
                    {group.rows.map((row) => (
                      <TableRow key={row.key} className="h-11">
                        <TableCell
                          className={cn(
                            "max-w-0",
                            stickyClass,
                            "group-hover/row:bg-fill-soft"
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-1">
                            <span className="min-w-0 truncate text-base">
                              {row.label}
                            </span>
                            <RoleMenu
                              label={row.label}
                              role={row.role}
                              onChoose={(role) => setRole(row.key, role)}
                            />
                          </div>
                        </TableCell>
                        {row.cells.map((cell, index) => {
                          const formula = columns[index]
                          if (!formula || cell === null) {
                            return (
                              <React.Fragment key={formula?.key ?? index}>
                                <TableCell
                                  className={cn(numberCell, "text-faint")}
                                >
                                  —
                                </TableCell>
                                <TableCell
                                  className={cn(numberCell, "text-faint")}
                                >
                                  —
                                </TableCell>
                              </React.Fragment>
                            )
                          }
                          return (
                            <React.Fragment key={formula.key}>
                              <TableCell className={numberCell}>
                                {gramsCell(formula, cell)}
                              </TableCell>
                              <TableCell
                                className={cn(
                                  numberCell,
                                  cell.percent === null && "text-faint"
                                )}
                              >
                                {formatPercent(cell.percent)}
                              </TableCell>
                            </React.Fragment>
                          )
                        })}
                        {twoColumns ? (
                          <TableCell
                            className={cn(
                              numberCell,
                              (row.delta === null ||
                                Math.abs(row.delta) < 0.05) &&
                                "text-muted-foreground"
                            )}
                          >
                            {formatDelta(row.delta)}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                    {group.rows.length > 1 ? (
                      <TableRow className="h-10 hover:bg-transparent">
                        <TableCell
                          className={cn("text-base font-medium", stickyClass)}
                        >
                          {group.label} total
                        </TableCell>
                        {group.subtotal.cells.map((cell, index) => (
                          <React.Fragment key={columns[index]?.key ?? index}>
                            <TableCell
                              className={cn(numberCell, "font-medium")}
                            >
                              {formatGrams(cell.grams)}
                            </TableCell>
                            <TableCell
                              className={cn(numberCell, "font-medium")}
                            >
                              {formatPercent(cell.percent)}
                            </TableCell>
                          </React.Fragment>
                        ))}
                        {twoColumns ? (
                          <TableCell className={cn(numberCell, "font-medium")}>
                            {formatDelta(group.subtotal.delta)}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                ))}
                <TableRow className="h-11 border-t border-border hover:bg-transparent">
                  <TableCell
                    className={cn("text-base font-medium", stickyClass)}
                  >
                    Total
                  </TableCell>
                  {comparison.total.cells.map((cell, index) => (
                    <React.Fragment key={columns[index]?.key ?? index}>
                      <TableCell className={cn(numberCell, "font-medium")}>
                        {formatGrams(cell.grams)}
                      </TableCell>
                      <TableCell className={cn(numberCell, "font-medium")}>
                        {formatPercent(cell.percent)}
                      </TableCell>
                    </React.Fragment>
                  ))}
                  {twoColumns ? (
                    <TableCell className={cn(numberCell, "font-medium")}>
                      {formatDelta(comparison.total.delta)}
                    </TableCell>
                  ) : null}
                </TableRow>
              </TableBody>
            </Table>
          </TableFrame>
          {notes.length ? (
            <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
              {notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          ) : null}

          <h2 className="mt-8 mb-3 text-xl leading-[normal] font-semibold tracking-[-0.01em] text-foreground">
            Formula
          </h2>
          <TableFrame className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableHeaderRow className="h-10">
                  <TableHead className="min-w-[200px]">% of flour</TableHead>
                  {columns.map((formula) => (
                    <TableHead
                      key={formula.key}
                      className="max-w-[200px] min-w-[120px] truncate text-right"
                    >
                      {formula.title}
                    </TableHead>
                  ))}
                  {twoColumns ? (
                    <TableHead className="w-20 text-right">Δ pts</TableHead>
                  ) : null}
                </TableHeaderRow>
              </TableHeader>
              <TableBody>
                {SUMMARY_ROWS.map(({ key, label }) => {
                  const values = columns.map((formula) => formula.summary[key])
                  return (
                    <TableRow key={key} className="h-10">
                      <TableCell className="text-base">{label}</TableCell>
                      {values.map((value, index) => (
                        <TableCell
                          key={columns[index]?.key ?? index}
                          className={cn(
                            numberCell,
                            value === null && "text-faint"
                          )}
                        >
                          {formatPercent(value)}
                        </TableCell>
                      ))}
                      {twoColumns ? (
                        <TableCell className={numberCell}>
                          {formatDelta(
                            pointsDelta(count, values[0], values[1])
                          )}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  )
                })}
                <TableRow className="h-10 hover:bg-transparent">
                  <TableCell className="text-base text-muted-foreground">
                    Not in the composition
                  </TableCell>
                  {columns.map((formula) => (
                    <TableCell
                      key={formula.key}
                      className="text-right text-xs whitespace-nowrap text-muted-foreground"
                    >
                      {[
                        formula.summary.unmappedCount > 0
                          ? `${formula.summary.unmappedCount} not mapped`
                          : null,
                        formula.summary.unweighedCount > 0
                          ? `${formula.summary.unweighedCount} unweighed`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </TableCell>
                  ))}
                  {twoColumns ? <TableCell /> : null}
                </TableRow>
              </TableBody>
            </Table>
          </TableFrame>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Estimates from built-in ingredient profiles and linked nutrition
            records. Water counts the water in milk, eggs and butter; hydration
            counts the liquid lines only. Sub-recipe lines and unmapped
            ingredients weigh in the totals but not in the composition.
          </p>
        </>
      )}
      {missingCount > 0 ? (
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
