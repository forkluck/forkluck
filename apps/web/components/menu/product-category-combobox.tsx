"use client"

import * as React from "react"
import { ChevronDown, CirclePlus } from "lucide-react"

import { SearchInput } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * The product's category: pick one the catalog already uses, or type a new one
 * and add it. The pantry's combobox in the product form's own 36px field.
 */
export function ProductCategoryCombobox({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: string) => void
  options: readonly string[]
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const typed = query.trim()
  const needle = typed.toLocaleLowerCase()
  // A chosen name the option list does not carry is still the value: one just
  // typed and added, or one saved before this list was read.
  const choices = React.useMemo(
    () => (value && !options.includes(value) ? [value, ...options] : options),
    [value, options]
  )
  const matches = choices.filter((option) =>
    option.toLocaleLowerCase().includes(needle)
  )
  const canAdd =
    typed.length > 0 &&
    !choices.some((option) => option.toLocaleLowerCase() === needle)
  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
    setQuery("")
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery("")
      }}
    >
      <PopoverTrigger
        aria-label="Category"
        className={cn(
          "flex h-9 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-card px-3 text-left text-md outline-none focus-visible:border-foreground enabled:not-focus:hover:border-line-strong data-popup-open:bg-accent",
          !value && "text-faint"
        )}
      >
        <span className="truncate">{value || "Uncategorized"}</span>
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
        <PopoverTitle className="sr-only">Choose a category</PopoverTitle>
        <div className="relative p-1.5">
          <SearchInput
            autoFocus
            maxLength={64}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              if (matches[0]) choose(matches[0])
              else if (canAdd) choose(typed)
            }}
            placeholder="Search or add"
            aria-label="Search categories"
            className="max-w-none"
            inputClassName="h-9"
          />
        </div>
        <div className="flex max-h-64 flex-col overflow-y-auto p-1.5">
          {canAdd ? (
            <button
              type="button"
              onClick={() => choose(typed)}
              className="flex min-h-9 w-full items-center gap-2.5 rounded-md bg-accent px-2.5 py-1.5 text-left text-base font-medium outline-none hover:bg-secondary-strong"
            >
              <CirclePlus className="size-[15px] shrink-0" aria-hidden="true" />
              <span className="truncate">Add “{typed}”</span>
            </button>
          ) : null}
          {/* Only a search that found nothing says so; an empty list is
                  not a failed search. */}
          {needle && matches.length === 0 && !canAdd ? (
            <span className="flex h-9 shrink-0 items-center px-2.5 text-base text-faint">
              No results
            </span>
          ) : null}
          {!needle ? (
            <button
              type="button"
              onClick={() => choose("")}
              className={cn(
                "flex min-h-9 w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent",
                !value && "bg-accent"
              )}
            >
              Uncategorized
            </button>
          ) : null}
          {matches.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => choose(option)}
              className={cn(
                "flex min-h-9 w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent",
                value === option && "bg-accent"
              )}
            >
              <span className="min-w-0 truncate">{option}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
