"use client"

import * as React from "react"
import { ChevronDown, CirclePlus } from "lucide-react"

import { SearchInput } from "@/components/ui/input"
import { LabeledShell } from "@/components/ui/labeled-field"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * The invoice's supplier: pick one the kitchen already buys from, or type the
 * name off the document. The value is the name; the import derives the key and
 * the backend creates the record for a name it has not seen.
 */
export function SupplierCombobox({
  value,
  onChange,
  options,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: readonly string[]
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const typed = query.trim()
  const needle = typed.toLocaleLowerCase()
  const matches = options.filter((option) =>
    option.toLocaleLowerCase().includes(needle)
  )
  const canAdd =
    typed.length > 0 &&
    !options.some((option) => option.toLocaleLowerCase() === needle)
  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
    setQuery("")
  }

  return (
    <LabeledShell label="Supplier" className={className}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) setQuery("")
        }}
      >
        <PopoverTrigger
          aria-label="Supplier"
          className={cn(
            "flex h-9 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-card px-3 text-left text-md outline-none focus-visible:border-foreground enabled:not-focus:hover:border-line-strong data-popup-open:bg-accent",
            !value && "text-muted-foreground"
          )}
        >
          <span className="truncate">{value || "Unnamed supplier"}</span>
          <ChevronDown
            className="size-[13px] shrink-0 text-muted-foreground"
            strokeWidth={2}
            aria-hidden="true"
          />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-(--anchor-width) min-w-[240px] p-0"
        >
          <PopoverTitle className="sr-only">Choose a supplier</PopoverTitle>
          <div className="relative p-1.5">
            <SearchInput
              autoFocus
              maxLength={120}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                event.preventDefault()
                if (matches[0]) choose(matches[0])
                else if (canAdd) choose(typed)
              }}
              placeholder="Search or add"
              aria-label="Search suppliers"
              className="max-w-none"
              inputClassName="h-9"
            />
          </div>
          <div className="flex max-h-64 flex-col overflow-y-auto p-1.5">
            {canAdd ? (
              <button
                type="button"
                onClick={() => choose(typed)}
                className="flex min-h-9 w-full items-center gap-2.5 rounded-md bg-accent px-2.5 py-1.5 text-left text-md font-medium outline-none hover:bg-secondary-strong"
              >
                <CirclePlus
                  className="size-[15px] shrink-0"
                  aria-hidden="true"
                />
                <span className="truncate">Add “{typed}”</span>
              </button>
            ) : null}
            {/* Only a search that found nothing says so; an empty list is
                  not a failed search. */}
            {needle && matches.length === 0 && !canAdd ? (
              <span className="flex h-9 shrink-0 items-center px-2.5 text-md text-muted-foreground">
                No results
              </span>
            ) : null}
            {matches.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => choose(option)}
                className={cn(
                  "flex min-h-9 w-full items-center rounded-md px-2.5 py-1.5 text-left text-md outline-none hover:bg-accent focus-visible:bg-accent",
                  value === option && "bg-accent"
                )}
              >
                <span className="min-w-0 truncate">{option}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </LabeledShell>
  )
}
