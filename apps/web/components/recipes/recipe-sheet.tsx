"use client"

import * as React from "react"

import { displayUnitShort } from "@/components/ingredients/unit-combobox"
import {
  BatchSizeSelect,
  ORIGINAL_BATCH,
} from "@/components/recipes/batch-size-select"
import { CustomBatchDialog } from "@/components/recipes/custom-batch-dialog"
import type { BatchSize } from "@/components/recipes/recipe-chrome"
import { Badge } from "@/components/ui/badge"
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
import type { GuestRecipe } from "@/lib/backend/types"
import {
  clampRecipeQuantity,
  formatMeasuredAmount,
  tidyVolume,
} from "@/lib/recipe"
import { convertAmount, countedAsEach } from "@/lib/unit-registry"
import { YIELD_UNIT_LABELS } from "@/lib/units"
import type { YieldUnit } from "@/lib/units"

type GuestLineKind = "header" | "note" | "ingredient" | "subrecipe"

type GuestMeasure = {
  kind: GuestLineKind
  displayName: string
  quantity: number | null
  unit: string
  preparationNote: string
}

/**
 * What a line shows at the batch being viewed: its own quantity and unit at
 * 1x, otherwise the scaled amount in the unit a cook would measure it with.
 * The same rule the editor's table applies, read-only.
 */
function shownMeasure(
  line: GuestMeasure,
  scale: number
): { amount: number | null; unit: string } {
  if (line.quantity === null) return { amount: null, unit: line.unit }
  if (scale === 1) return { amount: line.quantity, unit: line.unit }
  const tidy = tidyVolume(line.quantity * scale, line.unit)
  return {
    amount: Number(clampRecipeQuantity(tidy.amount)),
    unit: tidy.unit,
  }
}

type GuestSubrecipe = NonNullable<GuestRecipe["items"][number]["subrecipe"]>

/**
 * How many of the child's batches this line asks for: the line's amount at the
 * batch being viewed, in the child's yield unit, over the child's yield. Null
 * when the units do not relate or the child has no yield to divide by.
 */
function batchFactor(
  amount: number | null,
  unit: string,
  child: GuestSubrecipe
): number | null {
  if (amount === null || amount <= 0) return null
  if (!child.yieldAmount) return null
  // A yield counted in pieces or slices is asked for in "each": the same count
  // either way, so 1 slice of an 8 slice tart is an eighth of a batch.
  const inYieldUnit = convertAmount(
    amount,
    countedAsEach(unit) ?? unit,
    countedAsEach(child.yieldUnit)
  )
  if (inYieldUnit === null) return null
  return inYieldUnit / child.yieldAmount
}

/** "pcs" is what the database stores; a cook reads "ea". */
function yieldUnitWord(unit: string | null): string {
  return YIELD_UNIT_LABELS[unit as YieldUnit] ?? displayUnitShort(unit)
}

export function formatYield(amount: number, unit: string | null): string {
  return `${formatMeasuredAmount(amount, unit ?? "")} ${yieldUnitWord(unit)}`.trim()
}

/** Whether any line, the recipe's own or a nested one's, carries a note. */
function hasAnyNote(recipe: GuestRecipe): boolean {
  return recipe.items.some(
    (item) =>
      item.preparationNote ||
      item.subrecipe?.items.some((line) => line.preparationNote)
  )
}

type RowProps = {
  /** The notes column is only drawn when some line has one. */
  showNotes: boolean
}

/**
 * One measured line. Quantity and unit sit in their own columns, so every
 * number on the sheet lines up in one column and a phone never has to wrap
 * "8.7 g" word by word. On a phone the note follows the name instead of
 * taking a column.
 */
function LineRow({
  amount,
  unit,
  name,
  note,
  showNotes,
  component = false,
}: RowProps & {
  amount: number | null
  unit: string
  name: string
  note: string
  /** A line whose formula is its own block below, so its name carries the
   * heading's weight. */
  component?: boolean
}) {
  return (
    <TableRow className="hover:!bg-transparent">
      <TableCell className="whitespace-nowrap tabular-nums">
        {amount === null ? "" : formatMeasuredAmount(amount, unit)}
      </TableCell>
      <TableCell className="text-base whitespace-nowrap text-muted-foreground">
        {displayUnitShort(unit)}
      </TableCell>
      <TableCell className="py-2">
        {component ? <span className="font-medium">{name}</span> : name}
        {note ? (
          <span className="text-base text-muted-foreground italic sm:hidden">
            {" "}
            {note}
          </span>
        ) : null}
      </TableCell>
      {showNotes ? (
        <TableCell className="hidden text-base text-muted-foreground italic sm:table-cell">
          {note}
        </TableCell>
      ) : null}
    </TableRow>
  )
}

/** A heading or a note: text across the ingredient and notes columns. */
function TextRow({
  showNotes,
  children,
}: RowProps & { children: React.ReactNode }) {
  return (
    <TableRow className="hover:!bg-transparent">
      <TableCell colSpan={3 + (showNotes ? 1 : 0)}>{children}</TableCell>
    </TableRow>
  )
}

/**
 * A list of lines at one batch. The recipe's own list and every component's
 * block are the same table, so their columns line up down the page and a
 * component reads as its own formula rather than as more of the list above.
 */
function IngredientTable({
  items,
  scale,
  showNotes,
}: RowProps & {
  items: readonly (GuestMeasure & { subrecipe?: GuestSubrecipe | null })[]
  scale: number
}) {
  return (
    <TableFrame>
      <Table>
        <TableHeader>
          <TableHeaderRow>
            <TableHead className="w-14 sm:w-20">Qty</TableHead>
            <TableHead className="w-12 sm:w-24">Unit</TableHead>
            <TableHead>Ingredient</TableHead>
            {showNotes ? (
              <TableHead className="hidden w-48 sm:table-cell">Notes</TableHead>
            ) : null}
          </TableHeaderRow>
        </TableHeader>
        <TableBody>
          {items.map((item, index) => {
            if (item.kind === "header") {
              return (
                <TextRow key={index} showNotes={showNotes}>
                  <span className="font-medium">{item.displayName}</span>
                </TextRow>
              )
            }
            if (item.kind === "note") {
              return (
                <TextRow key={index} showNotes={showNotes}>
                  <span className="text-base text-muted-foreground italic">
                    {item.displayName}
                  </span>
                </TextRow>
              )
            }
            const measure = shownMeasure(item, scale)
            return (
              <LineRow
                key={index}
                showNotes={showNotes}
                amount={measure.amount}
                unit={measure.unit}
                name={item.displayName}
                note={item.preparationNote}
                component={Boolean(item.subrecipe)}
              />
            )
          })}
        </TableBody>
      </Table>
    </TableFrame>
  )
}

/**
 * One recipe as a guest reads it: a batch lens, the formula with a block per
 * component, and the method. No editing and no cost. A book holds one of
 * these per recipe, each at its own batch.
 */
export function RecipeSheet({ recipe }: { recipe: GuestRecipe }) {
  const [batch, setBatch] = React.useState<BatchSize>(ORIGINAL_BATCH)
  const [customOpen, setCustomOpen] = React.useState(false)
  const showNotes = hasAnyNote(recipe)
  const recipeYield =
    recipe.yieldAmount !== null && recipe.yieldUnit
      ? { amount: recipe.yieldAmount, unit: recipe.yieldUnit }
      : null
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="w-32 print:hidden">
          <BatchSizeSelect
            value={batch}
            onChange={setBatch}
            onCustom={() => setCustomOpen(true)}
            saved={recipe.batchSizes.filter((size) => !size.isOriginal)}
          />
        </div>
        {recipe.yieldAmount !== null ? (
          <p className="text-base text-muted-foreground tabular-nums">
            Makes{" "}
            {formatYield(recipe.yieldAmount * batch.scale, recipe.yieldUnit)}
          </p>
        ) : null}
      </div>

      <section className="grid gap-8">
        <div className="grid gap-3">
          <h2 className="text-lg font-semibold">Ingredients</h2>
          <IngredientTable
            items={recipe.items}
            scale={batch.scale}
            showNotes={showNotes}
          />
        </div>
        {recipe.items.map((item, index) => {
          const child = item.subrecipe
          if (!child) return null
          const measure = shownMeasure(item, batch.scale)
          const factor = batchFactor(measure.amount, measure.unit, child)
          // A guest reads what the batch makes, not the multiplier.
          const makes =
            child.yieldAmount !== null
              ? `Makes ${formatYield(child.yieldAmount * (factor ?? 1), child.yieldUnit)}`
              : ""
          return (
            <div key={index} className="grid gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <h3 className="text-md font-medium">{item.displayName}</h3>
                {factor === null || makes ? (
                  <p className="text-base text-muted-foreground tabular-nums">
                    {factor === null ? "Shown at 1x" : ""}
                    {factor === null && makes ? " · " : ""}
                    {makes}
                  </p>
                ) : null}
                <Badge size="row" className="rounded-sm px-[7px] text-2xs">
                  Sub-recipe
                </Badge>
              </div>
              <IngredientTable
                items={child.items}
                scale={factor ?? 1}
                showNotes={showNotes}
              />
            </div>
          )
        })}
      </section>

      {recipe.steps.length ? (
        <section className="grid gap-3">
          <h2 className="text-lg font-semibold">Prep method</h2>
          <div className="grid gap-3">
            {recipe.steps.map((entry, index) => {
              if (entry.kind === "header") {
                return (
                  <h3 key={index} className="mt-2 text-md font-medium">
                    {entry.title}
                  </h3>
                )
              }
              if (entry.kind === "note") {
                return (
                  <p
                    key={index}
                    className="text-md text-muted-foreground italic"
                  >
                    {entry.body}
                  </p>
                )
              }
              // Headers and notes carry no number, so the count is of steps.
              const number = recipe.steps
                .slice(0, index + 1)
                .filter((one) => one.kind === "instruction").length
              return (
                <div
                  key={index}
                  className="grid grid-cols-[24px_minmax(0,1fr)] gap-2"
                >
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {number}
                  </span>
                  <p className="text-md">{entry.body}</p>
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      <CustomBatchDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        recipeYield={recipeYield}
        onApply={setBatch}
      />
    </>
  )
}
