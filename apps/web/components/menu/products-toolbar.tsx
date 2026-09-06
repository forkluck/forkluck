"use client"

import * as React from "react"
import { SearchInput } from "@/components/ui/input"
import { Toolbar, ToolbarSpacer } from "@/components/ui/page"

/**
 * Search never shows its wait here: an in-flight search dims the results and
 * spins over them (`TableBusy`), so the field stays a plain field.
 */
export function ProductsToolbar({
  query,
  onQueryChange,
  searchLabel = "Search",
  filter,
  action,
}: {
  query: string
  onQueryChange: (value: string) => void
  searchLabel?: string
  /** The screen's own filter pill, sitting right after search. */
  filter?: React.ReactNode
  /** The screen action at the right edge — the black Add product button. */
  action?: React.ReactNode
}) {
  return (
    <Toolbar>
      <SearchInput
        label={searchLabel}
        className="max-w-none md:max-w-[196px]"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {/* On a phone the pills and the action share one wrapped line; at md+
          the wrapper dissolves into the toolbar's own row. */}
      {filter || action ? (
        <div className="flex flex-wrap items-center gap-2 md:contents">
          {filter}
          <ToolbarSpacer />
          {action}
        </div>
      ) : null}
    </Toolbar>
  )
}
