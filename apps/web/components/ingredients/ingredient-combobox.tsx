"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { ChevronDown, CirclePlus } from "lucide-react"

import {
  activateCatalogIngredient,
  searchCatalogIngredients,
} from "@/app/(app)/ingredients/actions"
import type { IngredientOption } from "@/components/ingredients/types"
import { Badge } from "@/components/ui/badge"
import type { CatalogIngredientSuggestion } from "@/lib/backend/schemas"
import { normalizeIngredientName } from "@/lib/pricing"
import { SearchInput } from "@/components/ui/input"
import { LabeledShell } from "@/components/ui/labeled-field"
import { cn } from "@/lib/utils"

const GROUP_LABEL = "px-2.5 pt-2 pb-1 text-2xs font-medium text-ink-soft"

const ROW_CLASS =
  "flex min-h-9 w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"

/**
 * Which pantry item a supplier line or a remembered pack points at, typed at
 * rather than scrolled to: a pantry runs to hundreds of rows and the invoice
 * review picks one per line. Supplies list under their own heading, because a
 * packaging line is looking for a different half of the pantry than a food one.
 *
 * The invoice review can also create the ingredient it names, so it passes
 * `createLabel` and that row stays first; the mapping table can only re-point
 * to one that exists.
 *
 * A name the pantry does not know is looked up in the catalog too, as the
 * recipe editor does: a catalog row is added to the pantry the moment it is
 * picked, and reported through `onCreated` so the screen's list learns it.
 */
export function IngredientCombobox({
  id,
  label = "Match ingredient",
  value,
  onChange,
  ingredients,
  createLabel,
  className,
  onCreated,
}: {
  id: string
  label?: string
  /** "" is the create option, and only exists with `createLabel`. */
  value: string
  onChange: (ingredientId: string) => void
  ingredients: IngredientOption[]
  createLabel?: string
  className?: string
  /** A catalog row was adopted into the pantry and is now the value. */
  onCreated?: (ingredient: IngredientOption) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  // Adopted this session: the list from the screen may not carry them yet.
  const [added, setAdded] = React.useState<IngredientOption[]>([])
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [catalogError, setCatalogError] = React.useState<string | null>(null)
  const known = React.useMemo(
    () => [
      ...ingredients,
      ...added.filter((one) => !ingredients.some((item) => item.id === one.id)),
    ],
    [ingredients, added]
  )
  const needle = query.trim().toLocaleLowerCase()
  const matches = known.filter((ingredient) =>
    ingredient.name.toLocaleLowerCase().includes(needle)
  )
  const foods = matches.filter((ingredient) => !ingredient.nonEdible)
  const supplies = matches.filter((ingredient) => ingredient.nonEdible)
  const selected = value
    ? known.find((ingredient) => ingredient.id === value)
    : undefined
  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
    setQuery("")
  }

  // Catalog rows only once the pantry has run short for the needle, fetched
  // after a pause and kept with the needle that fetched them, so an older
  // answer never stands in for what is being typed now.
  const wanted = needle.length >= 2 && foods.length < 8
  const [catalog, setCatalog] = React.useState<{
    needle: string
    rows: CatalogIngredientSuggestion[]
  }>({ needle: "", rows: [] })
  React.useEffect(() => {
    if (!wanted) return
    let live = true
    const timer = window.setTimeout(() => {
      void searchCatalogIngredients(needle).then((result) => {
        if (!live) return
        setCatalog({
          needle,
          rows:
            "error" in result
              ? []
              : result.items.filter(
                  (item) =>
                    !known.some(
                      (one) =>
                        normalizeIngredientName(one.name) ===
                        normalizeIngredientName(item.name)
                    )
                ),
        })
      })
    }, 300)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [needle, wanted, known])
  const catalogRows = wanted && catalog.needle === needle ? catalog.rows : []

  const adopt = async (row: CatalogIngredientSuggestion) => {
    setPendingId(row.id)
    setCatalogError(null)
    const result = await activateCatalogIngredient(row.id)
    setPendingId(null)
    if ("error" in result) {
      setCatalogError(result.error)
      return
    }
    const option = { id: result.id, name: result.name, nonEdible: false }
    setAdded((current) => [...current, option])
    onCreated?.(option)
    choose(option.id)
  }

  const group = (heading: string, rows: IngredientOption[]) =>
    rows.length === 0 ? null : (
      <React.Fragment key={heading}>
        <span className={GROUP_LABEL}>{heading}</span>
        {rows.map((ingredient) => (
          <button
            key={ingredient.id}
            type="button"
            onClick={() => choose(ingredient.id)}
            className={cn(ROW_CLASS, value === ingredient.id && "bg-accent")}
          >
            <span className="min-w-0 truncate">{ingredient.name}</span>
          </button>
        ))}
      </React.Fragment>
    )

  return (
    <LabeledShell label={label} className={className}>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) setQuery("")
        }}
      >
        <Popover.Trigger
          id={id}
          aria-label={label}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-card px-3 text-left text-md outline-none focus-visible:border-foreground enabled:not-focus:hover:border-line-strong data-popup-open:bg-accent",
            !selected && !createLabel && "text-faint"
          )}
        >
          <span className="truncate">
            {selected?.name ?? createLabel ?? "No ingredient"}
          </span>
          <ChevronDown
            className="size-[13px] shrink-0 text-muted-foreground"
            strokeWidth={2}
            aria-hidden="true"
          />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner align="start" sideOffset={4} className="z-50">
            <Popover.Popup className="z-50 w-(--anchor-width) min-w-[240px] origin-(--transform-origin) rounded-lg border border-popover-border bg-popover text-popover-foreground outline-none">
              <Popover.Title className="sr-only">{label}</Popover.Title>
              <div className="relative p-1.5">
                <SearchInput
                  autoFocus
                  maxLength={120}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    const first = foods[0] ?? supplies[0]
                    if (first) choose(first.id)
                    else if (createLabel) choose("")
                  }}
                  placeholder="Search ingredients"
                  aria-label="Search ingredients"
                  className="max-w-none"
                  inputClassName="h-9"
                />
              </div>
              <div className="flex max-h-64 flex-col overflow-y-auto p-1.5">
                {/* Creating what the line names is the answer for most review
                    lines, so it never moves below the search results. */}
                {createLabel ? (
                  <button
                    type="button"
                    onClick={() => choose("")}
                    className={cn(
                      "flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-base font-medium outline-none hover:bg-secondary-strong",
                      !value && "bg-accent"
                    )}
                  >
                    <CirclePlus
                      className="size-[15px] shrink-0"
                      aria-hidden="true"
                    />
                    <span className="truncate">{createLabel}</span>
                  </button>
                ) : null}
                {matches.length === 0 && catalogRows.length === 0 ? (
                  <span className="flex h-9 shrink-0 items-center px-2.5 text-base text-faint">
                    No results
                  </span>
                ) : null}
                {group("Ingredients", foods)}
                {group("Supplies", supplies)}
                {catalogRows.length > 0 ? (
                  <>
                    <span className={GROUP_LABEL}>Catalog</span>
                    {catalogRows.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        disabled={pendingId !== null}
                        onClick={() => void adopt(row)}
                        className={cn(ROW_CLASS, "justify-between gap-3")}
                      >
                        <span className="min-w-0 truncate">{row.name}</span>
                        <Badge variant="secondary">
                          {pendingId === row.id ? "Adding…" : "Catalog"}
                        </Badge>
                      </button>
                    ))}
                  </>
                ) : null}
                {catalogError ? (
                  <span className="px-2.5 py-1.5 text-xs text-destructive">
                    {catalogError}
                  </span>
                ) : null}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </LabeledShell>
  )
}
