"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { Check, ChevronDown, Search, X } from "lucide-react"

import type { SalesProductRow } from "@/lib/backend/types"
import {
  IGNORE_MODIFIER_ASSOCIATION,
  MIXED_MODIFIER_ASSOCIATION,
} from "@/lib/modifier-association-groups"
import { productSkus } from "@/lib/product-search"
import { rankedMatches, searchTokens } from "@/lib/search"
import { cn } from "@/lib/utils"

type ProductChoice = {
  value: string
  label: string
  kind: "none" | "mixed" | "ignore" | "product" | "current"
  product?: SalesProductRow
  skus: string[]
}

/**
 * The same anchored, searchable picker used for recipe categories, adapted for
 * modifier associations. Product rows can be found by title or any variant
 * SKU; the existing Not associated and Ignore decisions remain in the list.
 */
export function ProductAssociationPicker({
  products,
  value,
  currentProduct,
  allowIgnore,
  ariaLabel,
  onValueChange,
}: {
  products: SalesProductRow[]
  value: string
  /**
   * The product this modifier already counts as, looked up across every
   * product rather than the selectable ones. A mapping made before the
   * product was archived or turned into a bundle still counts toward sales,
   * so it stays in the list even though it is no longer a valid new target.
   */
  currentProduct?: SalesProductRow
  allowIgnore: boolean
  ariaLabel: string
  onValueChange: (value: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  const choices = React.useMemo<ProductChoice[]>(() => {
    const rows: ProductChoice[] = [
      {
        value: "",
        label: "Not associated",
        kind: "none",
        skus: [],
      },
      ...products.map((product) => ({
        value: product.id,
        label: product.name,
        kind: "product" as const,
        product,
        skus: productSkus(product),
      })),
    ]

    if (value === MIXED_MODIFIER_ASSOCIATION) {
      rows.unshift({
        value: MIXED_MODIFIER_ASSOCIATION,
        label: "Different products — choose one",
        kind: "mixed",
        skus: [],
      })
    } else if (
      value &&
      value !== IGNORE_MODIFIER_ASSOCIATION &&
      !rows.some((row) => row.value === value)
    ) {
      // Without this the picker would read "Not associated" and the first
      // save would silently drop a mapping that sales still rely on.
      rows.unshift({
        value,
        label: currentProduct?.name ?? "Current product",
        kind: "current",
        product: currentProduct,
        skus: currentProduct ? productSkus(currentProduct) : [],
      })
    }
    if (allowIgnore) {
      rows.push({
        value: IGNORE_MODIFIER_ASSOCIATION,
        label: "Ignore — not a product",
        kind: "ignore",
        skus: [],
      })
    }
    return rows
  }, [allowIgnore, currentProduct, products, value])

  const selected =
    choices.find((choice) => choice.value === value) ?? choices[0]!
  // Product rows offer name and SKUs; "Not associated" and "Ignore" offer
  // their label. Ranked, so the closest name leads.
  const matches = rankedMatches(
    choices,
    (choice) =>
      choice.product
        ? [choice.product.name, ...productSkus(choice.product)]
        : [choice.label],
    query
  )

  const choose = (choice: ProductChoice) => {
    if (choice.kind === "mixed") return
    setOpen(false)
    setQuery("")
    onValueChange(choice.value)
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) setQuery("")
      }}
    >
      <Popover.Trigger
        aria-label={ariaLabel}
        className="flex h-9 w-full min-w-0 items-center justify-between gap-2.5 rounded-md border border-input bg-card px-3 text-left text-md text-foreground outline-none focus-visible:border-foreground enabled:hover:border-line-strong data-popup-open:border-line-strong data-popup-open:bg-accent"
      >
        <span className="truncate">{selected.label}</span>
        <ChevronDown
          aria-hidden="true"
          className="size-[13px] shrink-0 text-muted-foreground"
          strokeWidth={2}
        />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="z-50 w-[360px] max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-lg border border-popover-border bg-popover text-popover-foreground outline-none">
            <Popover.Title className="sr-only">{ariaLabel}</Popover.Title>
            <div className="relative border-b border-muted p-2">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-[19px] size-[15px] -translate-y-1/2 text-faint"
                strokeWidth={2}
              />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  // Only a typed search picks the top row. On an empty box
                  // that row is "Not associated", so a bare Enter would clear
                  // the mapping the merchant just opened the picker to see.
                  if (searchTokens(query).length === 0) return
                  if (matches.length === 0) return
                  choose(matches[0]!)
                }}
                placeholder="Search product title or SKU"
                aria-label="Search product title or SKU"
                className="h-9 w-full bg-transparent pr-8 pl-8 text-base text-foreground outline-none placeholder:text-faint"
              />
              {query ? (
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-3 flex size-[22px] -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
                >
                  <X aria-hidden="true" className="size-3.5" strokeWidth={2} />
                </button>
              ) : null}
            </div>

            <div className="flex max-h-[300px] flex-col overflow-y-auto p-1.5">
              {matches.length === 0 ? (
                <span className="flex min-h-14 items-center justify-center px-2.5 text-center text-base text-faint">
                  No products match that title or SKU.
                </span>
              ) : (
                matches.map((choice) => (
                  <ProductOption
                    key={choice.value || "not-associated"}
                    choice={choice}
                    selected={choice.value === value}
                    onClick={() => choose(choice)}
                  />
                ))
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function ProductOption({
  choice,
  selected,
  onClick,
}: {
  choice: ProductChoice
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={choice.kind === "mixed"}
      onClick={onClick}
      className={cn(
        "group/option flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-md outline-none hover:bg-accent disabled:cursor-default disabled:text-faint",
        selected && "bg-accent"
      )}
    >
      <Check
        aria-hidden="true"
        strokeWidth={2}
        className={cn(
          "size-[15px] shrink-0",
          selected
            ? "text-foreground"
            : "text-disabled-foreground opacity-0 group-hover/option:opacity-100"
        )}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate",
            choice.kind === "ignore" && "text-muted-foreground"
          )}
        >
          {choice.label}
        </span>
        {choice.kind === "current" ? (
          <span className="mt-0.5 block truncate text-2xs text-faint">
            Still counted here — no longer a product you can pick
          </span>
        ) : null}
        {choice.skus.length ? (
          <span className="mt-0.5 block truncate text-2xs text-faint">
            {choice.skus.length === 1 ? "SKU" : "SKUs"} {choice.skus.join(", ")}
          </span>
        ) : null}
      </span>
    </button>
  )
}
