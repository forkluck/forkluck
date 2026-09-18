"use client"

import * as React from "react"
import { Check, ChevronDown, Search, X } from "lucide-react"

import type { SalesProductRow } from "@/lib/backend/types"
import { productSkus } from "@/lib/product-search"
import { rankedMatches, searchTokens } from "@/lib/search"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type Choice = {
  value: string
  label: string
  product?: SalesProductRow
  skus: string[]
}

/**
 * The Track dialog's "Product to link" control: the same anchored, searchable
 * picker recipe categories and modifier associations use. "A new product"
 * leads; existing products can be found by title or any variant SKU. The
 * product form's 36px field, meant to sit inside a `LabeledShell`.
 */
export function ProductLinkPicker({
  products,
  value,
  onValueChange,
  disabled,
}: {
  products: SalesProductRow[]
  /** "new" or a product id. */
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  const choices = React.useMemo<Choice[]>(
    () => [
      { value: "new", label: "A new product", skus: [] },
      ...products.map((product) => ({
        value: product.id,
        label: product.name,
        product,
        skus: productSkus(product),
      })),
    ],
    [products]
  )

  const selected =
    choices.find((choice) => choice.value === value) ?? choices[0]!
  const matches = rankedMatches(
    choices,
    (choice) =>
      choice.product ? [choice.product.name, ...choice.skus] : [choice.label],
    query
  )

  const choose = (choice: Choice) => {
    setOpen(false)
    setQuery("")
    onValueChange(choice.value)
  }

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) setQuery("")
      }}
    >
      <PopoverTrigger
        aria-label="Product to link"
        disabled={disabled}
        className={cn(
          "flex h-9 w-full min-w-0 items-center justify-between gap-1.5 rounded-md border border-input bg-card px-3 text-left text-md outline-none",
          disabled
            ? "text-muted-foreground"
            : "text-foreground hover:border-line-strong focus-visible:border-foreground data-popup-open:border-line-strong data-popup-open:bg-accent"
        )}
      >
        <span className="truncate">
          {selected.product
            ? `Existing product: ${selected.label}`
            : selected.label}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-[13px] shrink-0 text-muted-foreground"
          strokeWidth={2}
        />
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[360px] max-w-(--available-width) overflow-hidden p-0"
      >
        <PopoverTitle className="sr-only">Product to link</PopoverTitle>
        <div className="relative border-b border-muted p-2">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-[19px] size-[15px] -translate-y-1/2 text-muted-foreground"
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
              // that row is "A new product", so a bare Enter would drop
              // the choice the merchant opened the picker to check.
              if (searchTokens(query).length === 0) return
              if (matches.length === 0) return
              choose(matches[0]!)
            }}
            placeholder="Search product title or SKU"
            aria-label="Search product title or SKU"
            className="h-9 w-full bg-transparent pr-8 pl-8 text-base text-foreground outline-none placeholder:text-muted-foreground"
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
            <span className="flex min-h-14 items-center justify-center px-2.5 text-center text-base text-muted-foreground">
              No products match that title or SKU.
            </span>
          ) : (
            matches.map((choice) => (
              <button
                key={choice.value}
                type="button"
                onClick={() => choose(choice)}
                className={cn(
                  "group/option flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-md outline-none hover:bg-accent",
                  choice.value === value && "bg-accent"
                )}
              >
                <Check
                  aria-hidden="true"
                  strokeWidth={2}
                  className={cn(
                    "size-[15px] shrink-0",
                    choice.value === value
                      ? "text-foreground"
                      : "text-disabled-foreground opacity-0 group-hover/option:opacity-100"
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{choice.label}</span>
                  {choice.skus.length ? (
                    <span className="mt-0.5 block truncate text-base text-muted-foreground">
                      {choice.skus.length === 1 ? "SKU" : "SKUs"}{" "}
                      {choice.skus.join(", ")}
                    </span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
