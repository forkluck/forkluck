"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { Check, CirclePlus, X } from "lucide-react"

import type { IngredientTagOptionRow } from "@/lib/backend/types"
import { SearchInput } from "@/components/ui/input"
import { cn } from "@/lib/utils"

const MAX_TAGS = 50
const MAX_TAG_LENGTH = 80

const normalized = (value: string) => value.trim().toLocaleLowerCase()

export function IngredientTagsCard({
  options,
  value,
  onChange,
}: {
  options: IngredientTagOptionRow[]
  value: string[]
  onChange: (value: string[]) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const fieldRef = React.useRef<HTMLDivElement>(null)
  const selected = new Set(value.map(normalized))
  const rows = React.useMemo(() => {
    const byName = new Map(
      options.map((option) => [normalized(option.name), option] as const)
    )
    for (const name of value) {
      if (!byName.has(normalized(name))) {
        byName.set(normalized(name), {
          id: `new:${normalized(name)}`,
          name,
          count: 0,
        })
      }
    }
    return [...byName.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    )
  }, [options, value])
  const trimmed = query.trim()
  const needle = normalized(trimmed)
  const matches = rows.filter((row) => normalized(row.name).includes(needle))
  const frequent = [...rows]
    .filter((row) => row.count > 0)
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    )
    .slice(0, 5)
  const frequentIds = new Set(frequent.map((row) => row.id))
  const other = rows.filter((row) => !frequentIds.has(row.id))
  const canAdd =
    needle.length > 0 &&
    trimmed.length <= MAX_TAG_LENGTH &&
    !rows.some((row) => normalized(row.name) === needle) &&
    value.length < MAX_TAGS

  const toggle = (name: string) => {
    const key = normalized(name)
    onChange(
      selected.has(key)
        ? value.filter((tag) => normalized(tag) !== key)
        : value.length < MAX_TAGS
          ? [...value, name]
          : value
    )
  }

  const addTyped = () => {
    if (!canAdd) return
    onChange([...value, trimmed])
    setQuery("")
  }

  const optionButton = (option: IngredientTagOptionRow) => {
    const checked = selected.has(normalized(option.name))
    return (
      <button
        key={option.id}
        type="button"
        aria-pressed={checked}
        disabled={!checked && value.length >= MAX_TAGS}
        onClick={() => toggle(option.name)}
        className="flex min-h-9 w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-base outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:text-faint"
      >
        <span
          className={cn(
            "flex size-[15px] shrink-0 items-center justify-center rounded-sm border",
            checked
              ? "border-foreground bg-foreground text-background"
              : "border-faint bg-card"
          )}
          aria-hidden="true"
        >
          {checked ? <Check className="size-[11px]" strokeWidth={3} /> : null}
        </span>
        <span className="truncate">{option.name}</span>
      </button>
    )
  }

  return (
    <div className="self-start">
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery("")
        }}
      >
        <div className="mb-3 flex min-h-7 items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Tags</h2>
          {value.length > 0 ? (
            <Popover.Trigger
              type="button"
              aria-label="Add tags"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
            >
              <CirclePlus
                className="size-[17px]"
                strokeWidth={2}
                aria-hidden="true"
              />
            </Popover.Trigger>
          ) : null}
        </div>
        <div
          ref={fieldRef}
          className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-md border border-input bg-card p-2 outline-none focus-within:border-foreground hover:border-line-strong"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) return
            setOpen(true)
          }}
        >
          {value.map((name) => (
            <span
              key={normalized(name)}
              className="flex h-7 max-w-full items-center gap-1.5 rounded-md bg-secondary px-2 text-xs text-foreground"
            >
              <span className="truncate">{name}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  toggle(name)
                }}
                aria-label={`Remove ${name}`}
                className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
              >
                <X className="size-3" strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
          ))}
          {value.length === 0 ? (
            <Popover.Trigger
              type="button"
              aria-label="Add tags"
              className="flex h-7 items-center gap-1.5 rounded-md bg-secondary px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-secondary-strong hover:text-foreground focus-visible:text-foreground"
            >
              <CirclePlus
                className="size-[14px]"
                strokeWidth={2}
                aria-hidden="true"
              />
              Add tags
            </Popover.Trigger>
          ) : null}
          <Popover.Portal>
            <Popover.Positioner
              anchor={fieldRef}
              align="start"
              sideOffset={6}
              className="z-50"
            >
              <Popover.Popup className="z-50 w-[var(--anchor-width)] max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-lg border border-popover-border bg-popover text-popover-foreground outline-none">
                <Popover.Title className="px-3.5 pt-3 text-sm font-medium">
                  Tags
                </Popover.Title>
                <div className="relative p-1.5">
                  <SearchInput
                    autoFocus
                    maxLength={MAX_TAG_LENGTH}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return
                      event.preventDefault()
                      if (canAdd) addTyped()
                      else if (matches.length === 1) toggle(matches[0]!.name)
                    }}
                    placeholder="Search or add tags"
                    aria-label="Search or add tags"
                    className="max-w-none"
                    inputClassName="h-9 pr-9"
                  />
                  {query ? (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setQuery("")}
                      aria-label="Clear tag search"
                      className="absolute top-1/2 right-[15px] flex size-[22px] -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
                    >
                      <X
                        className="size-3.5"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </button>
                  ) : null}
                </div>
                <div className="flex max-h-[360px] flex-col overflow-y-auto p-1.5">
                  {needle ? (
                    <>
                      <span className="px-2.5 pt-1.5 pb-1 text-2xs font-medium text-faint">
                        {matches.length}{" "}
                        {matches.length === 1 ? "result" : "results"}
                      </span>
                      {canAdd ? (
                        <button
                          type="button"
                          onClick={addTyped}
                          className="flex min-h-9 w-full items-center gap-2.5 rounded-md bg-accent px-2.5 py-1.5 text-left text-base font-medium outline-none hover:bg-secondary-strong"
                        >
                          <CirclePlus
                            className="size-[15px] shrink-0"
                            aria-hidden="true"
                          />
                          <span className="truncate">Add “{trimmed}”</span>
                        </button>
                      ) : null}
                      {matches.map(optionButton)}
                    </>
                  ) : (
                    <>
                      {frequent.length > 0 ? (
                        <>
                          <span className="px-2.5 pt-1.5 pb-1 text-2xs font-medium text-faint">
                            Frequently used
                          </span>
                          {frequent.map(optionButton)}
                        </>
                      ) : null}
                      {other.length > 0 ? (
                        <>
                          <span className="px-2.5 pt-2 pb-1 text-2xs font-medium text-faint">
                            {frequent.length > 0 ? "Other tags" : "All tags"}
                          </span>
                          {other.map(optionButton)}
                        </>
                      ) : null}
                      {rows.length === 0 ? (
                        <span className="flex min-h-14 items-center justify-center px-2.5 text-center text-sm text-faint">
                          Search to create your first tag.
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </div>
      </Popover.Root>
    </div>
  )
}
