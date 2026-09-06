"use client"

import { Calculator, ChevronDown, X } from "lucide-react"

import type { BatchSize } from "@/components/recipes/recipe-chrome"
import {
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu"
import { cn } from "@/lib/utils"

/** The multiples every recipe can be viewed at, before any the cook names. */
export const ORIGINAL_BATCH: BatchSize = {
  label: "1x",
  scale: 1,
  isOriginal: true,
}

export const BUILT_IN_BATCHES: BatchSize[] = [
  { label: "½x", scale: 0.5, isOriginal: false },
  ORIGINAL_BATCH,
  { label: "2x", scale: 2, isOriginal: false },
]

const same = (a: BatchSize, b: BatchSize) =>
  a.scale === b.scale && a.label === b.label

/**
 * A lens over the recipe: pick a batch and every quantity shows multiplied.
 * Half, one and two, then the calculator for anything else.
 */
export function BatchSizeSelect({
  value,
  onChange,
  onCustom,
  saved = [],
  onRemove,
  className,
}: {
  value: BatchSize
  onChange: (batch: BatchSize) => void
  /** Opens the calculator: a multiple, or an amount to make. */
  onCustom?: () => void
  /** The custom batches this recipe keeps, listed after the built-ins. */
  saved?: BatchSize[]
  /** Absent where the saved list cannot be changed. */
  onRemove?: (batch: BatchSize) => void
  className?: string
}) {
  const listed =
    BUILT_IN_BATCHES.some((size) => same(size, value)) ||
    saved.some((size) => same(size, value))
  return (
    <Menu>
      <MenuTrigger
        aria-label="Batch size"
        className={cn(
          "flex h-9 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-card px-3 text-left text-md tabular-nums outline-none focus-visible:border-foreground enabled:not-focus:hover:border-line-strong data-popup-open:bg-accent",
          className
        )}
      >
        <span className="truncate">{value.label || `${value.scale}x`}</span>
        <ChevronDown
          className="size-[13px] shrink-0 text-muted-foreground"
          strokeWidth={2}
          aria-hidden="true"
        />
      </MenuTrigger>
      <MenuContent align="start" className="w-56">
        {BUILT_IN_BATCHES.map((size) => (
          <MenuCheckItem
            key={size.label}
            checked={same(size, value)}
            onClick={() => onChange(size)}
          >
            {size.label}
          </MenuCheckItem>
        ))}
        {saved.map((size) => (
          <MenuCheckItem
            key={`${size.label}-${size.scale}`}
            checked={same(size, value)}
            onClick={() => onChange(size)}
          >
            <span className="min-w-0 flex-1 truncate">
              {size.label || `${size.scale}x`}
            </span>
            {onRemove ? (
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Remove ${size.label || `${size.scale}x`}`}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onRemove(size)
                }}
                className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive"
              >
                <X className="size-[13px]" strokeWidth={2} aria-hidden="true" />
              </span>
            ) : null}
          </MenuCheckItem>
        ))}
        {!listed ? (
          <MenuCheckItem checked onClick={() => onChange(value)}>
            {value.label || `${value.scale}x`}
          </MenuCheckItem>
        ) : null}
        {onCustom ? (
          <MenuItem onClick={onCustom}>
            <Calculator strokeWidth={1.8} aria-hidden="true" />
            Custom…
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  )
}
