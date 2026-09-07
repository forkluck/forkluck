"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { ChevronDown } from "lucide-react"

import { unitLabel, unitShort } from "@/lib/unit-registry"
import type { UnitOption } from "@/lib/unit-registry"
import { SearchInput } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export const MAX_UNIT_LENGTH = 40

/**
 * The inline chip shell: a 28px underlined value that sits *inside* a field
 * rather than beside it, the way the amount/unit pairs read on the ingredient
 * panels. Exported because one chip in that screen opens a Menu rather than
 * this combobox, and the two have to stay the same object.
 */
export const inlineChipClassName =
  "flex h-7 items-center gap-1 rounded-lg px-1.5 text-2xs font-semibold text-foreground outline-none hover:bg-accent focus-visible:bg-accent"

/** "cup" stays a word: a lone "c" reads as nothing in a kitchen. */
export const displayUnitShort = (slug: string | null) =>
  slug === "cup" ? "cup" : unitShort(slug)

/**
 * A searchable unit field. Units come from the shared registry; the search
 * narrows that controlled vocabulary but never creates a new unit.
 *
 * The value is always a slug — `kg`, `fl-oz`, a typed unit's own slug — because
 * the recipe parser has to recognise it later. Labels are for reading.
 */
export function UnitCombobox({
  id,
  label,
  invalid = false,
  value,
  onChange,
  options,
  disabled = false,
  variant = "field",
  emptyLabel,
  className,
  popupClassName,
}: {
  id?: string
  label: string
  /** Marks the trigger when the form reports a missing unit. */
  invalid?: boolean
  value: string | null
  onChange: (value: string | null) => void
  options: UnitOption[]
  disabled?: boolean
  /**
   * `field` is the 48px row that owns its own line. `chip` is the inline
   * 28px version that sits inside another field, next to the amount.
   */
  variant?: "field" | "chip"
  /** What the trigger reads with nothing chosen. A picker where blank means
   * something ("batches") names it, and offers it as the first row. */
  emptyLabel?: string
  className?: string
  popupClassName?: string
}) {
  const chip = variant === "chip"
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  // A unit typed in earlier sits on no shelf, so it leads the list.
  const rows = React.useMemo(() => {
    if (!value || options.some((option) => option.slug === value))
      return options
    return [{ slug: value, label: unitLabel(value) }, ...options]
  }, [options, value])

  const needle = query.trim().toLocaleLowerCase()
  const matches = rows.filter(
    (row) =>
      row.slug.toLocaleLowerCase().includes(needle) ||
      row.label.toLocaleLowerCase().includes(needle)
  )
  const choose = (next: string | null) => {
    onChange(next)
    setOpen(false)
    setQuery("")
  }

  const trigger = (
    <Popover.Trigger
      id={id}
      aria-label={`${label} unit`}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      className={cn(
        "disabled:cursor-not-allowed disabled:text-faint aria-invalid:text-destructive data-popup-open:bg-fill-soft",
        chip
          ? cn(inlineChipClassName, "w-auto min-w-0 justify-center self-center")
          : cn(
              "flex h-12 w-full items-center justify-between gap-1.5 px-3.5 text-left text-md outline-none focus-visible:bg-fill-soft",
              value ? "text-foreground" : "text-faint"
            ),
        !chip && className
      )}
    >
      <span
        className={cn(
          "truncate underline",
          chip
            ? "decoration-current underline-offset-2"
            : "decoration-1 underline-offset-4"
        )}
      >
        {displayUnitShort(value) || emptyLabel || "Unit"}
      </span>
      <ChevronDown
        className={cn(
          "shrink-0",
          chip
            ? "size-3.5 text-foreground"
            : "size-[13px] text-muted-foreground"
        )}
        strokeWidth={2}
        aria-hidden="true"
      />
    </Popover.Trigger>
  )

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery("")
      }}
    >
      {/* In a field the chip is one grid cell: a faint slash parts it from
          the amount, outside the button so it never takes the hover fill. */}
      {chip ? (
        <span className={cn("flex items-center self-center", className)}>
          <span aria-hidden="true" className="pr-1 text-sm text-faint">
            /
          </span>
          {trigger}
        </span>
      ) : (
        trigger
      )}
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={4} className="z-50">
          <Popover.Popup
            className={cn(
              "z-50 w-[240px] max-w-(--available-width) origin-(--transform-origin) rounded-lg border border-popover-border bg-popover text-popover-foreground outline-none",
              popupClassName
            )}
          >
            <Popover.Title className="sr-only">
              Choose {label.toLocaleLowerCase()} unit
            </Popover.Title>
            <div className="relative p-1.5">
              <SearchInput
                autoFocus
                maxLength={MAX_UNIT_LENGTH}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || matches.length === 0) return
                  event.preventDefault()
                  choose(matches[0].slug)
                }}
                placeholder="Search"
                aria-label="Search units"
                className="max-w-none"
                inputClassName="h-9"
              />
            </div>
            <div className="flex max-h-64 flex-col overflow-y-auto p-1.5">
              {emptyLabel && !needle ? (
                <button
                  type="button"
                  onClick={() => choose(null)}
                  className={cn(
                    "flex min-h-9 w-full shrink-0 items-center rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent",
                    !value && "bg-accent"
                  )}
                >
                  {emptyLabel}
                </button>
              ) : null}
              {matches.length === 0 ? (
                <span className="flex h-9 shrink-0 items-center px-2.5 text-base text-faint">
                  No results
                </span>
              ) : null}
              {matches.map((option, index) => (
                <React.Fragment key={option.slug}>
                  {option.heading &&
                  option.heading !== matches[index - 1]?.heading ? (
                    <span className="shrink-0 px-2.5 pt-2 pb-1 text-2xs leading-none font-medium text-faint">
                      {option.heading}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => choose(option.slug)}
                    className={cn(
                      "flex min-h-9 w-full shrink-0 items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent",
                      value === option.slug && "bg-accent"
                    )}
                  >
                    <span className="min-w-0 truncate">
                      {option.label.replace(` (${unitShort(option.slug)})`, "")}
                    </span>
                    {displayUnitShort(option.slug).toLocaleLowerCase() !==
                    option.label.toLocaleLowerCase() ? (
                      <span className="shrink-0 text-muted-foreground">
                        {displayUnitShort(option.slug)}
                      </span>
                    ) : null}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
