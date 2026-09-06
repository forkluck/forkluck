"use client"

import { ChevronDown } from "lucide-react"
import * as React from "react"

import type { LabelRegion } from "@/lib/business-settings"
import {
  ALLERGENS,
  declaredAllergenKeys,
  type AllergenKey,
} from "@/lib/nutrition/allergens"
import { cn } from "@/lib/utils"

export type AllergenRow = "contains" | "mayContain"

const ROWS: { row: AllergenRow; label: string }[] = [
  { row: "contains", label: "Contains" },
  { row: "mayContain", label: "May contain" },
]

const chipClassName =
  "inline-flex h-5 items-center rounded-full border px-2 text-2xs font-medium whitespace-nowrap"

/**
 * The nineteen kitchen tags in two rows, Contains and May contain. A tag sits
 * in one row at a time; pressing it in the other row moves it. Selected chips
 * fill with ink, never blue: this is a selection, not data.
 *
 * The region leads: its declared tags are on show, the rest wait behind More
 * tags. A selected tag never hides, so nothing already set can slip away.
 */
export function AllergenChips({
  value,
  region,
  onToggle,
  readOnly = false,
  disabled = false,
}: {
  value: { contains: readonly string[]; mayContain: readonly string[] }
  /** Whose labelling rules decide which tags lead. */
  region: LabelRegion
  onToggle?: (key: AllergenKey, row: AllergenRow) => void
  /** Renders only the selected tags, as plain text. */
  readOnly?: boolean
  disabled?: boolean
}) {
  const declared = declaredAllergenKeys(region)
  return (
    <div className="flex flex-col gap-2.5">
      {ROWS.map(({ row, label }) => (
        <AllergenRowChips
          key={row}
          row={row}
          label={label}
          declared={declared}
          selected={new Set(value[row])}
          onToggle={onToggle}
          readOnly={readOnly}
          disabled={disabled}
        />
      ))}
    </div>
  )
}

function AllergenRowChips({
  row,
  label,
  declared,
  selected,
  onToggle,
  readOnly,
  disabled,
}: {
  row: AllergenRow
  label: string
  declared: ReadonlySet<AllergenKey>
  selected: Set<string>
  onToggle?: (key: AllergenKey, row: AllergenRow) => void
  readOnly: boolean
  disabled: boolean
}) {
  const [expanded, setExpanded] = React.useState(false)
  const entries = readOnly
    ? ALLERGENS.filter((entry) => selected.has(entry.key))
    : ALLERGENS.filter(
        (entry) =>
          expanded || declared.has(entry.key) || selected.has(entry.key)
      )
  const hiddenCount = readOnly
    ? 0
    : ALLERGENS.length -
      ALLERGENS.filter(
        (entry) => declared.has(entry.key) || selected.has(entry.key)
      ).length

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div
        role={readOnly ? undefined : "group"}
        aria-label={readOnly ? undefined : label}
        className="flex flex-wrap gap-1.5"
      >
        {readOnly && entries.length === 0 ? (
          <span className="text-sm text-muted-foreground">None listed</span>
        ) : null}
        {entries.map((entry) =>
          readOnly ? (
            <span
              key={entry.key}
              className={cn(
                chipClassName,
                "border-foreground bg-foreground text-background"
              )}
            >
              {entry.label}
            </span>
          ) : (
            <button
              key={entry.key}
              type="button"
              aria-pressed={selected.has(entry.key)}
              disabled={disabled}
              onClick={() => onToggle?.(entry.key, row)}
              className={cn(
                chipClassName,
                "outline-none focus-visible:border-foreground disabled:cursor-not-allowed",
                selected.has(entry.key)
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:border-line-strong hover:text-foreground"
              )}
            >
              {entry.label}
            </button>
          )
        )}
        {hiddenCount > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex h-5 items-center gap-1 rounded-full px-2 text-2xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
          >
            More tags
            <ChevronDown
              className={cn("size-3", expanded && "rotate-180")}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
    </div>
  )
}
