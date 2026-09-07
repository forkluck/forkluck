"use client"

import * as React from "react"
import { Printer } from "lucide-react"

import { useBusinessSettings } from "@/components/business-settings-provider"
import { Button } from "@/components/ui/button"
import { TabPill, TabPills } from "@/components/ui/tab-pills"
import type { NutrientKey } from "@/lib/backend/schemas"
import type { Nutrients } from "@/lib/backend/types"
import {
  containsLine,
  declaredAllergens,
  formatAmount,
  formatEuRows,
  formatUsRows,
  NUTRIENT_LABELS,
  servingsPerContainer,
  SPECIES_KEYS,
  statementRuns,
  type LabelFormat,
  type LabelRow,
  type StatementEntry,
} from "@/lib/nutrition/label"
import { cn } from "@/lib/utils"

const ESTIMATE_FOOTER =
  "It is a preview, not a verified label. Accuracy on a package is the seller\u2019s responsibility, so have the numbers verified before you print one."

const FORMAT_STORAGE_KEY = "nutrition-label-format"

export type LabelServing = {
  amount: number | null
  unit: string
  grams: number | null
}

export type NutritionLabelProps = {
  format: LabelFormat
  serving: LabelServing
  /** Servings in the batch, for the US panel's first line. */
  servings: number | null
  perServing: Nutrients | null
  per100g: Nutrients | null
  /** Ingredient statement entries, heaviest first. */
  statement: readonly StatementEntry[]
  allergens: { contains: readonly string[]; mayContain: readonly string[] }
  /** What stops the per-serving column, shown where its figures would be. */
  servingNote?: string | null
}

function servingLabel(serving: LabelServing): string {
  const stated =
    serving.amount === null
      ? ""
      : `${formatAmount(serving.amount)} ${serving.unit}`.trim()
  const grams = serving.grams === null ? "" : `${formatAmount(serving.grams)} g`
  if (stated && grams && serving.unit !== "g") return `${stated} (${grams})`
  return stated || grams || "Not set"
}

function UsRow({ row }: { row: LabelRow }) {
  const bold = row.indent === 0
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-2 border-b border-foreground/60 py-0.5 text-[12px] leading-[1.4]",
        row.indent === 1 && "pl-4",
        row.indent === 2 && "pl-8"
      )}
    >
      <span>
        {row.key === "addedSugars" ? (
          <>
            Includes {row.amount}
            {row.unit} Added Sugars
          </>
        ) : (
          <>
            <span className={cn(bold && "font-bold")}>{row.label}</span>{" "}
            {row.amount}
            {row.unit}
          </>
        )}
      </span>
      {row.percent === null ? null : (
        <span className="font-bold tabular-nums">{row.percent}%</span>
      )}
    </div>
  )
}

function UsPanel({
  serving,
  servings,
  perServing,
  servingNote,
}: Pick<
  NutritionLabelProps,
  "serving" | "servings" | "perServing" | "servingNote"
>) {
  const facts = perServing ? formatUsRows(perServing) : null
  return (
    <div className="w-full border-2 border-foreground bg-card px-2 py-1.5 text-foreground">
      <h3 className="text-[26px] leading-none font-black tracking-tight">
        Nutrition Facts
      </h3>
      <div className="mt-1 border-b border-foreground/60 py-0.5 text-[12px]">
        {servings === null
          ? "Servings per container not set"
          : servingsPerContainer(servings)}
      </div>
      <div className="flex items-baseline justify-between gap-2 border-b-[8px] border-foreground py-0.5 text-[13px] font-bold">
        <span>Serving size</span>
        <span>{servingLabel(serving)}</span>
      </div>
      {facts ? (
        <>
          <div className="flex items-end justify-between gap-2 border-b-[4px] border-foreground py-0.5">
            <span className="flex flex-col">
              <span className="text-[11px] font-bold">Amount per serving</span>
              <span className="text-[22px] leading-none font-black">
                Calories
              </span>
            </span>
            <span className="text-[30px] leading-none font-black tabular-nums">
              {facts.calories}
            </span>
          </div>
          <div className="border-b border-foreground/60 py-0.5 text-right text-[10.5px] font-bold">
            % Daily Value*
          </div>
          {facts.rows.map((row) => (
            <UsRow key={row.key} row={row} />
          ))}
          <div className="border-b-[8px] border-foreground" />
          {facts.vitamins.map((row) => (
            <UsRow key={row.key} row={row} />
          ))}
          <p className="mt-1 text-[9.5px] leading-[1.35]">
            * The % Daily Value tells you how much a nutrient in a serving of
            food contributes to a daily diet. 2,000 calories a day is used for
            general nutrition advice.
          </p>
        </>
      ) : (
        <p className="py-3 text-[12.5px] leading-[1.55] text-muted-foreground">
          {servingNote ?? "Set a serving size to build the preview."}
        </p>
      )}
    </div>
  )
}

/** One EU cell. Energy stacks its kJ over its kcal so three columns fit the
 * card; everything else stays on one line. */
function EuCell({ value }: { value: string }) {
  const parts = value.split(" / ")
  return (
    <span className="inline-flex flex-col items-end whitespace-nowrap">
      {parts.map((part, index) => (
        <span key={index}>{part}</span>
      ))}
    </span>
  )
}

function EuTable({
  serving,
  per100g,
  perServing,
  servingNote,
}: Pick<
  NutritionLabelProps,
  "serving" | "per100g" | "perServing" | "servingNote"
>) {
  if (!per100g) return null
  const rows = formatEuRows(per100g, perServing)
  return (
    <div className="w-full overflow-x-auto border border-foreground bg-card text-foreground">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-foreground">
            <th className="px-2 py-1 text-left font-bold">Nutrition</th>
            <th className="px-2 py-1 text-right font-bold whitespace-nowrap">
              Per 100 g
            </th>
            {perServing ? (
              <th className="px-2 py-1 text-right font-bold whitespace-nowrap">
                Per serving
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className="border-b border-foreground/40 last:border-b-0"
            >
              <td
                className={cn(
                  "px-2 py-1",
                  row.indent ? "pl-5 text-muted-foreground" : "font-medium"
                )}
              >
                {row.label}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                <EuCell value={row.per100g} />
              </td>
              {perServing ? (
                <td className="px-2 py-1 text-right tabular-nums">
                  <EuCell value={row.perServing ?? ""} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {perServing ? (
        <p className="border-t border-foreground/40 px-2 py-1.5 text-[11.5px] leading-[1.5] text-muted-foreground">
          One serving is {servingLabel(serving)}.
        </p>
      ) : servingNote ? (
        <p className="border-t border-foreground/40 px-2 py-1.5 text-[11.5px] leading-[1.5] text-muted-foreground">
          {servingNote}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The label as it would print: the FDA-shaped panel or the EU per-100 g
 * table, then the ingredient statement and the CONTAINS line for the
 * format's declared tags. A nutrient not every record reports prints the sum
 * of what is known; the card's note beneath the label says which ones.
 */
export function NutritionLabel(props: NutritionLabelProps) {
  const { format, statement, allergens } = props
  const runs = statementRuns(statement, format)
  const contains = containsLine(statement, allergens.contains, format)
  const kitchenSplit = declaredAllergens(allergens.contains, format)
  const mayContain = declaredAllergens(allergens.mayContain, format)
  const kitchen = [...new Set([...kitchenSplit.kitchen, ...mayContain.kitchen])]
  // The sentence only stands where the label could not name the kind.
  const species =
    contains.unnamedSpecies ||
    allergens.mayContain.some((key) => SPECIES_KEYS.has(key))
  return (
    // The width of a real panel, so the preview reads like the sticker it
    // becomes rather than a stretched table.
    <div className="flex w-full max-w-[300px] flex-col gap-3">
      {format === "us" ? <UsPanel {...props} /> : <EuTable {...props} />}
      <div className="flex flex-col gap-1 text-[12px] leading-[1.5] text-foreground">
        {runs.length > 0 ? (
          <p>
            <span className="font-bold uppercase">Ingredients:</span>{" "}
            {runs.map((run, index) => (
              <React.Fragment key={`${run.name}-${index}`}>
                {index > 0 ? ", " : null}
                {run.emphasised ? <strong>{run.name}</strong> : run.name}
              </React.Fragment>
            ))}
          </p>
        ) : null}
        {contains.groups.length > 0 ? (
          <p>
            <span className="font-bold uppercase">Contains:</span>{" "}
            {contains.groups.join(", ")}
          </p>
        ) : null}
        {mayContain.declared.length > 0 ? (
          <p>
            <span className="font-bold uppercase">May contain:</span>{" "}
            {mayContain.declared.join(", ")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 text-[12px] leading-[1.5] text-muted-foreground">
        {kitchen.length > 0 ? (
          <p>
            Kitchen tags not on {format === "us" ? "a US" : "an EU"} label:{" "}
            {kitchen.join(", ")}
          </p>
        ) : null}
        {species ? (
          <p>A real label names the nut, fish or shellfish species.</p>
        ) : null}
        <p>{ESTIMATE_FOOTER}</p>
      </div>
    </div>
  )
}

export type NutritionReadiness = {
  ready: boolean
  missing: readonly NutrientKey[]
}

/**
 * The card the preview lives in: the US / EU pills, remembered per browser,
 * the label, the per-format note on what is still unknown, and Print. While
 * something stops the preview from building, the card is the checklist.
 */
export function NutritionLabelCard({
  serving,
  servings,
  perServing,
  per100g,
  statement,
  allergens,
  readiness,
  blockers,
  servingBlockers,
  className,
}: Omit<NutritionLabelProps, "format" | "servingNote"> & {
  readiness: { us: NutritionReadiness; eu: NutritionReadiness }
  /** Sentences that stop every total; the card shows only these. */
  blockers: readonly string[]
  /** Sentences about the serving; per 100 g still renders without one. */
  servingBlockers: readonly string[]
  className?: string
}) {
  const region = useBusinessSettings().labelRegion ?? "us"
  const [format, setFormat] = React.useState<LabelFormat>(region)
  // This browser's last choice, read after mount: the server cannot know it,
  // so it overrides the business region only once the page is live.
  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(FORMAT_STORAGE_KEY)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored === "us" || stored === "eu") setFormat(stored)
    } catch {
      // Private mode or a blocked store: the default format is fine.
    }
  }, [])
  const chooseFormat = (next: LabelFormat) => {
    setFormat(next)
    try {
      window.localStorage.setItem(FORMAT_STORAGE_KEY, next)
    } catch {
      // Nothing to remember it in; the choice still holds for this page.
    }
  }
  const blocked = blockers.length > 0
  const missing = readiness[format].missing
  const servingNote =
    servingBlockers.length > 0 ? servingBlockers.join(" ") : null

  return (
    <section className={cn("flex flex-col gap-4", className)}>
      {/* As wide as the label below, so the format pills sit on its edge. */}
      <div className="flex max-w-[300px] items-center justify-between gap-3 print:hidden">
        <h2 className="text-[16px] font-semibold text-foreground">
          Label preview
        </h2>
        {blocked ? null : (
          <TabPills>
            <TabPill
              active={format === "us"}
              onClick={() => chooseFormat("us")}
            >
              US
            </TabPill>
            <TabPill
              active={format === "eu"}
              onClick={() => chooseFormat("eu")}
            >
              EU
            </TabPill>
          </TabPills>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {blocked ? (
          <Checklist items={blockers} />
        ) : (
          <>
            <NutritionLabel
              format={format}
              serving={serving}
              servings={servings}
              perServing={perServing}
              per100g={per100g}
              statement={statement}
              allergens={allergens}
              servingNote={servingNote}
            />
            {missing.length === 0 ? null : (
              <p className="text-[12.5px] leading-[1.55] text-muted-foreground print:hidden">
                The label counts only what the linked records report, so these
                are understated:{" "}
                {missing.map((key) => NUTRIENT_LABELS[key]).join(", ")}. Link a
                fuller record or request a custom value.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit print:hidden"
              onClick={() => window.print()}
            >
              <Printer strokeWidth={1.8} aria-hidden="true" />
              Print preview
            </Button>
          </>
        )}
      </div>
    </section>
  )
}

function Checklist({ items }: { items: readonly string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[13px] font-medium">Before the preview can build</h3>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-[12.5px] leading-[1.55] text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
