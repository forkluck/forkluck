"use client"

import * as React from "react"
import type { RowData } from "@tanstack/react-table"
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFns,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
} from "@tanstack/react-table"
import { Check, ChevronDown, ChevronsUpDown, ChevronUp, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ColumnsMenu } from "@/components/ui/columns-menu"
import { FilterPill } from "@/components/ui/filter-pill"
import { SearchInput } from "@/components/ui/input"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import {
  Table,
  TableBody,
  TableBusy,
  TableCell,
  TableEmpty,
  TableFrame,
  TableHead,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

/**
 * The feature set every table in the app shares. v9 requires features to be
 * registered explicitly — a missing state API here means a missing feature,
 * not a typing problem. Declared at module scope because `useTable` expects
 * `features`, `data`, and `columns` to be referentially stable.
 */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  // v9 requires sort/filter functions to be registered the same way features
  // are. Without these, a column whose type resolves to an unregistered fn
  // (a plain string column picks `text`) silently refuses to sort — it warns
  // in the console and nothing happens on click.
  sortFns,
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns,
  columnVisibilityFeature,
  rowSelectionFeature,
})

export type DataTableFeatures = typeof dataTableFeatures

/** The sentinel a segment pill uses for "no filter"; never a real value. */
const ALL_SEGMENT = "__all_segments__"

/**
 * True when the event landed on something inside a cell that handles its own
 * click or Enter, so a clickable row must stay out of the way. Role selectors
 * matter here: Base UI renders checkboxes and switches as spans, not buttons.
 */
export function ownsItsOwnActivation(target: EventTarget | null): boolean {
  return Boolean(
    (target as HTMLElement | null)?.closest(
      "a,button,input,label,select,textarea,[role=checkbox],[role=switch],[role=menuitem]"
    )
  )
}

/**
 * One single-select toolbar pill — "Type All", "Status Applied". Exported so a
 * screen that has to own a pill's value (the Invoices banner sets Status) can
 * type the array it hands back.
 */
export type SegmentFilter<TData> = {
  label: string
  options: Array<{ value: string; label: string }>
  getValue: (row: TData) => string
  /** Preselects an option, hiding other rows until the viewer changes it. */
  defaultValue?: string
  /** Set both to own the selection from outside; the pill is then controlled. */
  value?: string | null
  onValueChange?: (value: string | null) => void
  /** Widens the popover past the 168px default. */
  contentClassName?: string
}

/** The shared Columns menu over this table's hideable columns. */
function TableColumnsMenu({
  table,
}: {
  table: {
    getAllColumns: () => Array<{
      id: string
      columnDef: { header?: unknown }
      getCanHide: () => boolean
      getIsVisible: () => boolean
      toggleVisibility: (visible?: boolean) => void
    }>
  }
}) {
  return (
    <ColumnsMenu
      columns={table
        .getAllColumns()
        .filter((column) => column.getCanHide())
        .map((column) => ({
          id: column.id,
          label:
            typeof column.columnDef.header === "string"
              ? column.columnDef.header
              : column.id,
          visible: column.getIsVisible(),
          onToggle: (visible) => column.toggleVisibility(visible),
        }))}
    />
  )
}

/**
 * Column helper bound to the shared feature set. Callers must use this rather
 * than `createColumnHelper` directly, so column defs line up with the features
 * DataTable actually registers.
 */
export function dataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>()
}

export type DataTableRemote = {
  searchValue: string
  onSearchValueChange: (value: string) => void
  /** True while a committed search is still waiting on the server. */
  searchPending?: boolean
  order: string
  sortColumns: Record<string, { asc: string; desc: string }>
  onOrderChange: (order: string) => void
}

type DataTableProps<TData extends RowData> = {
  /** Built with `dataTableColumns<TData>()`. Memoize at the call site. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: Array<any>
  data: TData[]
  /** Stable row identity. Required for selection to survive sorting. */
  getRowId?: (row: TData) => string
  searchPlaceholder?: string
  emptyMessage?: string
  /** Adds the leading checkbox column and enables the bulk-action bar. */
  enableSelection?: boolean
  /**
   * Overrides the selection column's track, which defaults to 32px. Keep an
   * override in fixed pixels: under `table-fixed` a percentage absorbs what
   * the other columns leave unclaimed, so a hidden column widens it.
   */
  selectColumnClassName?: string
  bulkActions?: (context: {
    rows: TData[]
    clear: () => void
  }) => React.ReactNode
  /**
   * Extra controls rendered at the toolbar's right edge. The function form
   * receives the current selection, for controls like "Export n rows".
   */
  toolbarExtra?:
    | React.ReactNode
    | ((context: {
        selectedRows: TData[]
        /** Rows after search, column, and segment filtering. */
        visibleRows: TData[]
        clearSelection: () => void
      }) => React.ReactNode)
  /** Controls placed immediately after search, before the table's own pills. */
  toolbarLeading?: React.ReactNode
  /**
   * Adds the Columns menu to the toolbar, remembering what the viewer hides
   * under `columns:<storageKey>`. `defaultHidden` seeds only the first visit;
   * after that the stored choice is the whole answer.
   */
  columnsMenu?: {
    storageKey: string
    defaultHidden?: string[]
    /** Places the selector over a trailing row-control column. */
    headerColumnId?: string
  }
  /**
   * Single-select filter pills rendered as "Label Value" (the "Type All"
   * pill). Each filters the data directly via getValue, so it needs no
   * column. A defaultValue preselects an option, hiding other rows until
   * the viewer changes it. Memoize the array at the call site — it feeds
   * the table's data memo.
   *
   * Pass `value` + `onValueChange` to own the selection from outside — the
   * Invoices banner's Review button sets the Status pill that way. A filter
   * with `value` set is fully controlled; without it the table keeps the
   * state itself.
   */
  segmentFilters?: Array<SegmentFilter<TData>>
  /**
   * Rendered between the toolbar and the table frame — where the handoff puts
   * a needs-attention banner (Invoices, Ingredients, Products). Anything here
   * sits inside the table's own 16px rhythm rather than above the toolbar.
   */
  notice?: React.ReactNode
  /**
   * Rendered in place of the table, with the toolbar and notice left standing.
   * The handoff's drag-over state is exactly this: the table gives way to a
   * 420px dashed drop box and the toolbar stays where it is.
   */
  tableReplacement?: React.ReactNode
  /**
   * Makes the whole row clickable. Clicks landing on a link, button, or
   * checkbox inside the row are left to that element, so selection and
   * inline actions keep working.
   */
  onRowClick?: (row: TData) => void
  /** Extra class for a body row (e.g. dimming inactive rows). */
  rowClassName?: (row: TData) => string | undefined
  /**
   * Lets a domain feature own search and ordering in URL state. In this mode
   * DataTable renders the controls, but does not apply a second client-side
   * search or sort to the server-provided page.
   */
  remote?: DataTableRemote
  /** Domain-owned browse controls rendered after the table or mobile cards. */
  footer?: React.ReactNode
  /**
   * Drops the search/filter/columns row. For tables that are one section of a
   * grouped list, where a single search above the sections owns the filtering
   * and a per-table search box would only fragment it.
   */
  hideToolbar?: boolean
  /**
   * Pins the first column (and the selection checkbox before it) to the left
   * edge while the rest of the row scrolls sideways, so a row never loses its
   * name. On by default; the hairline on the pinned edge only shows once the
   * table has actually scrolled. The pinned column sits exactly after the
   * selection track, whatever width the screen gave it.
   */
  stickyFirstColumn?: boolean
  /**
   * Pins the trailing `actions` column to the right edge, so the row menu is
   * reachable at any scroll position instead of only at the far end. On by
   * default, and inert for a table without such a column; its hairline shows
   * while the table still has somewhere to scroll.
   */
  stickyActionsColumn?: boolean
  /**
   * Optional sizing for the native table itself. Screens with several compact
   * metric columns use `table-fixed` plus proportional column widths so spare
   * room is shared across the row instead of collecting in one name column.
   */
  tableClassName?: string
  className?: string
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  searchPlaceholder = "Search",
  emptyMessage = "No results.",
  enableSelection = false,
  selectColumnClassName = "w-8",
  bulkActions,
  toolbarExtra,
  toolbarLeading,
  columnsMenu,
  segmentFilters,
  notice,
  tableReplacement,
  onRowClick,
  rowClassName,
  remote,
  footer,
  hideToolbar = false,
  stickyFirstColumn = true,
  stickyActionsColumn = true,
  tableClassName,
  className,
}: DataTableProps<TData>) {
  const helper = React.useMemo(() => dataTableColumns<TData>(), [])

  const [segments, setSegments] = React.useState<Array<string | null>>(() =>
    (segmentFilters ?? []).map((filter) => filter.defaultValue ?? null)
  )
  // A controlled filter reads its value from the caller; the rest keep theirs
  // here, so one screen can drive a single pill without owning all of them.
  const segmentValue = (index: number) => {
    const filter = segmentFilters?.[index]
    return filter && filter.value !== undefined
      ? filter.value
      : (segments[index] ?? null)
  }
  const setSegment = (index: number, value: string | null) => {
    const filter = segmentFilters?.[index]
    if (filter?.onValueChange) {
      filter.onValueChange(value)
      if (filter.value !== undefined) return
    }
    setSegments((previous) => {
      const next = [...previous]
      next[index] = value
      return next
    })
  }
  const controlledSegments = (segmentFilters ?? [])
    .map((filter) => filter.value ?? "")
    .join("\u0000")
  const tableData = React.useMemo(() => {
    if (!segmentFilters?.length) return data
    return data.filter((row) =>
      segmentFilters.every((filter, index) => {
        const selected =
          filter.value !== undefined ? filter.value : (segments[index] ?? null)
        return !selected || filter.getValue(row) === selected
      })
    )
    // `controlledSegments` stands in for the caller-owned values, which live
    // outside `segments`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, segmentFilters, segments, controlledSegments])

  const resolvedColumns = React.useMemo(() => {
    if (!enableSelection) return columns
    const selectColumn = helper.display({
      id: "select",
      enableSorting: false,
      enableHiding: false,
      meta: { className: selectColumnClassName, minWidth: 32 },
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllRowsSelected()}
          indeterminate={
            table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected()
          }
          onCheckedChange={(checked) => table.toggleAllRowsSelected(!!checked)}
          aria-label="Select all rows"
        />
      ),
      // What keeps selecting a row from also navigating is the row's own click
      // guard, not anything here. Base UI renders this as a <span
      // role="checkbox"> with a sibling <input>, so that guard has to match on
      // role and tag rather than assuming a <button>.
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(checked) => row.toggleSelected(!!checked)}
          aria-label="Select row"
        />
      ),
    })
    return [selectColumn, ...columns]
  }, [columns, enableSelection, helper, selectColumnClassName])

  const columnsStorageKey = columnsMenu
    ? `columns:${columnsMenu.storageKey}`
    : null
  const [columnVisibility, setColumnVisibility] = React.useState<
    Record<string, boolean>
  >(() =>
    Object.fromEntries(
      (columnsMenu?.defaultHidden ?? []).map((id) => [id, false])
    )
  )

  // After mount, not in the initializer: localStorage is absent on the server
  // and seeding from it there would mismatch on hydration.
  React.useEffect(() => {
    if (!columnsStorageKey) return
    const stored = window.localStorage.getItem(columnsStorageKey)
    if (!stored) return
    try {
      const hidden: unknown = JSON.parse(stored)
      if (!Array.isArray(hidden)) return
      // The server cannot know what this browser hid, so the correction has
      // to land after mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setColumnVisibility(
        Object.fromEntries(hidden.map((id) => [String(id), false]))
      )
    } catch {
      // Hand-edited or written by something else. Start everything visible.
    }
  }, [columnsStorageKey])

  // Resolved outside the updater, like `toggleFilterValue`: updaters run
  // during render, and this one writes.
  const changeColumnVisibility = (
    updater:
      | Record<string, boolean>
      | ((previous: Record<string, boolean>) => Record<string, boolean>)
  ) => {
    const next =
      typeof updater === "function" ? updater(columnVisibility) : updater
    setColumnVisibility(next)
    if (!columnsStorageKey) return
    const hidden = Object.entries(next)
      .filter(([, visible]) => !visible)
      .map(([id]) => id)
    window.localStorage.setItem(columnsStorageKey, JSON.stringify(hidden))
  }

  const table = useTable({
    features: dataTableFeatures,
    columns: resolvedColumns,
    data: tableData,
    state: { columnVisibility },
    onColumnVisibilityChange: changeColumnVisibility,
    getRowId: getRowId
      ? (row: TData, index: number) => getRowId(row) ?? String(index)
      : undefined,
  })

  // A row that leaves the data (deleted, filtered, refreshed away) must also
  // leave the selection, or the header checkbox reads mixed forever.
  React.useEffect(() => {
    if (!enableSelection) return
    const ids = new Set(table.getRowModel().rows.map((row) => row.id))
    table.setRowSelection((selection) => {
      const stale = Object.keys(selection).filter((id) => !ids.has(id))
      if (stale.length === 0) return selection
      const next = { ...selection }
      for (const id of stale) delete next[id]
      return next
    })
  }, [enableSelection, table, tableData])

  // Summed over the *visible* columns, so hiding one lowers the floor instead
  // of scrolling the survivors out of view.
  const minTableWidth = table
    .getAllColumns()
    .filter((column) => column.getIsVisible())
    .reduce((total, column) => total + columnMinWidth(column), 0)

  const rows = table.getRowModel().rows
  const selectedRows = enableSelection ? table.getSelectedRowModel().rows : []

  const [scrolled, setScrolled] = React.useState(false)
  // Whether the row's right edge is already on screen; while it is not, the
  // pinned actions column draws its hairline, the mirror of `scrolled`.
  const [atEnd, setAtEnd] = React.useState(true)
  const readEdges = React.useCallback((frame: HTMLElement) => {
    setScrolled(frame.scrollLeft > 0)
    setAtEnd(frame.scrollLeft + frame.clientWidth >= frame.scrollWidth - 1)
  }, [])
  // A table can overflow without ever being scrolled, so the first read comes
  // from the frame itself rather than from a scroll event.
  const frameRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return
      readEdges(node)
      if (typeof ResizeObserver === "undefined") return
      const observer = new ResizeObserver(() => readEdges(node))
      observer.observe(node)
      return () => observer.disconnect()
    },
    [readEdges]
  )
  // The selection track's rendered width, so the pinned name column starts
  // exactly where the track ends instead of assuming a size the screen may
  // have overridden.
  const [selectWidth, setSelectWidth] = React.useState(0)
  const selectHeaderRef = React.useCallback(
    (node: HTMLTableCellElement | null) => {
      if (!node || typeof ResizeObserver === "undefined") return
      const observer = new ResizeObserver(([entry]) =>
        setSelectWidth(entry.contentRect.width)
      )
      observer.observe(node)
      return () => observer.disconnect()
    },
    []
  )
  const visibleColumnIds = table
    .getAllColumns()
    .filter((column) => column.getIsVisible())
    .map((column) => column.id)
  const firstDataColumnId = visibleColumnIds.find((id) => id !== "select")
  // Only a trailing actions column pins right: one with columns after it would
  // park over its own neighbours.
  const actionsColumnId =
    stickyActionsColumn && visibleColumnIds.at(-1) === "actions"
      ? "actions"
      : undefined
  // The pinned cells paint their own background, matching the row at rest
  // and on hover, so the columns sliding underneath never show through.
  const stickyClass = (columnId: string) => {
    if (columnId === actionsColumnId)
      return cn(
        "sticky right-0 z-[1] bg-card before:absolute before:inset-y-0 before:left-0 before:w-px before:content-['']",
        atEnd ? "before:bg-transparent" : "before:bg-border"
      )
    if (!stickyFirstColumn) return undefined
    if (columnId === "select") return "sticky left-0 z-[1] bg-card"
    if (columnId !== firstDataColumnId) return undefined
    return cn(
      "sticky z-[1] bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:content-['']",
      scrolled ? "after:bg-border" : "after:bg-transparent"
    )
  }
  const stickyStyle = (columnId: string): React.CSSProperties | undefined =>
    stickyFirstColumn && columnId === firstDataColumnId
      ? { left: enableSelection ? selectWidth : 0 }
      : undefined

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Search · filters · spacer · whatever the screen adds on the right.
          16px above the table, 8px between controls — the same rhythm
          `Toolbar` in components/ui/page.tsx draws for screens without one. */}
      <div
        className={cn(
          "mb-4 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center",
          hideToolbar && "hidden"
        )}
      >
        {/* Full width on a phone, where the row is a stack; back to its 196px
            track once the toolbar is a row again. */}
        <SearchInput
          className="max-w-none md:max-w-[196px]"
          label={searchPlaceholder}
          value={remote?.searchValue}
          onChange={(event) => {
            if (remote) remote.onSearchValueChange(event.target.value)
            else table.setGlobalFilter(event.target.value)
          }}
        />
        {/* `md:contents` dissolves these groups back into the toolbar row at
            md+, so the desktop layout is exactly what it was; on a phone each
            is its own wrapping line under the search field. */}
        {toolbarLeading || segmentFilters?.length ? (
          <div className="flex flex-wrap items-center gap-2 md:contents">
            {toolbarLeading}
            {(segmentFilters ?? []).map((filter, index) => (
              // A segment filter is a FilterPill whose empty value is spelled
              // "All", so the toolbar's pills are the app's pills.
              <FilterPill
                key={filter.label}
                label={filter.label}
                value={segmentValue(index) ?? ALL_SEGMENT}
                options={[
                  { value: ALL_SEGMENT, label: "All" },
                  ...filter.options,
                ]}
                contentClassName={filter.contentClassName}
                onSelect={(value) =>
                  setSegment(index, value === ALL_SEGMENT ? null : value)
                }
              />
            ))}
          </div>
        ) : null}
        {/* The spacer the design puts between filters and screen actions —
            nothing to space out while the toolbar is a stack. */}
        <div className="hidden flex-1 md:block" />
        {(columnsMenu && !columnsMenu.headerColumnId) || toolbarExtra ? (
          <div className="flex flex-wrap items-center gap-2 md:contents">
            {/* With a header column named, the columns menu lives in the table
                header instead. */}
            {columnsMenu && !columnsMenu.headerColumnId ? (
              <TableColumnsMenu table={table} />
            ) : null}
            {/* The screen's actions wrap as one group, so a narrow toolbar
                never strands a primary button on a line of its own. */}
            {toolbarExtra ? (
              <div className="flex shrink-0 items-center gap-2">
                {typeof toolbarExtra === "function"
                  ? toolbarExtra({
                      selectedRows: selectedRows.map((row) => row.original),
                      visibleRows: rows.map((row) => row.original),
                      clearSelection: () => table.toggleAllRowsSelected(false),
                    })
                  : toolbarExtra}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* The needs-attention banner's slot: below the toolbar, above the
          table, exactly where the handoff draws it. Rendered bare so a banner
          that decides it has nothing to say costs no space — its own 12px
          bottom margin comes from `NoticeBanner`. */}
      {notice}

      {tableReplacement}

      {/* Over the frame, not inside it: the bar must not pan with the columns. */}
      <div className={cn("relative", tableReplacement && "hidden")}>
        {enableSelection && selectedRows.length > 0 ? (
          <div className="absolute inset-x-0 top-0 z-10 flex h-[49px] items-center gap-2.5 border-b border-border bg-card px-0.5">
            <Checkbox
              checked={table.getIsAllRowsSelected()}
              indeterminate={
                table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected()
              }
              onCheckedChange={(checked) =>
                table.toggleAllRowsSelected(!!checked)
              }
              aria-label="Select all rows"
            />
            {/* A ghost pill, not a button — the count is a label you can open,
                so it carries no border until the cursor is on it. */}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    className="h-[30px] gap-1.5 rounded-lg px-[9px] text-foreground tabular-nums"
                  >
                    {selectedRows.length} selected
                    <ChevronDown
                      className="size-[13px]"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </Button>
                }
              />
              <MenuContent align="start" className="w-[176px]">
                {!table.getIsAllRowsSelected() ? (
                  <MenuItem onClick={() => table.toggleAllRowsSelected(true)}>
                    <Check strokeWidth={1.8} aria-hidden="true" />
                    Select all
                  </MenuItem>
                ) : null}
                <MenuItem onClick={() => table.toggleAllRowsSelected(false)}>
                  <X strokeWidth={1.8} aria-hidden="true" />
                  Unselect all
                </MenuItem>
              </MenuContent>
            </Menu>
            {/* Bulk actions sit right next to the selection dropdown. */}
            {bulkActions?.({
              rows: selectedRows.map((row) => row.original),
              clear: () => table.toggleAllRowsSelected(false),
            })}
          </div>
        ) : null}
        <TableFrame
          ref={frameRef}
          className="overflow-x-auto"
          onScroll={(event) => readEdges(event.currentTarget)}
        >
          {/* Bulk actions float over the header row instead of replacing its
            cells — the column labels stay in the layout underneath, so the
            browser never recomputes column widths and nothing shifts. The
            height matches the 48px header row plus its hairline. */}
          <Table
            className={cn(
              tableClassName,
              minTableWidth && "min-w-(--table-min-w)"
            )}
            style={
              minTableWidth
                ? ({
                    "--table-min-w": `${minTableWidth}px`,
                  } as React.CSSProperties)
                : undefined
            }
          >
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableHeaderRow key={group.id}>
                  {group.headers.map((header) => {
                    const remoteSort = remote?.sortColumns[header.column.id]
                    const sorted = remoteSort
                      ? remote.order === remoteSort.asc
                        ? "asc"
                        : remote.order === remoteSort.desc
                          ? "desc"
                          : false
                      : header.column.getIsSorted()
                    // A remote table that names no sortable columns has left
                    // ordering to the client: its page is small and sorts
                    // where it stands.
                    const canSort = remoteSort
                      ? true
                      : remote && Object.keys(remote.sortColumns).length > 0
                        ? false
                        : header.column.getCanSort()
                    return (
                      <TableHead
                        key={header.id}
                        ref={
                          stickyFirstColumn && header.column.id === "select"
                            ? selectHeaderRef
                            : undefined
                        }
                        style={stickyStyle(header.column.id)}
                        className={cn(
                          columnAlign(header.column) === "right" &&
                            "text-right tabular-nums",
                          columnAlign(header.column) === "center" &&
                            "text-center",
                          columnClass(header.column),
                          stickyClass(header.column.id)
                        )}
                      >
                        {columnsMenu?.headerColumnId === header.column.id ? (
                          <div className="flex justify-end">
                            <TableColumnsMenu table={table} />
                          </div>
                        ) : header.isPlaceholder ? null : canSort ? (
                          // No focus ring anywhere in this design: the invisible
                          // border turns ink on keyboard focus instead.
                          <button
                            type="button"
                            onClick={
                              remoteSort
                                ? () =>
                                    remote?.onOrderChange(
                                      sorted === "asc"
                                        ? remoteSort.desc
                                        : remoteSort.asc
                                    )
                                : header.column.getToggleSortingHandler()
                            }
                            className={cn(
                              "inline-flex items-center gap-[5px] rounded-md border border-transparent focus-visible:border-foreground focus-visible:outline-none",
                              columnAlign(header.column) === "right" &&
                                "justify-end"
                            )}
                          >
                            <table.FlexRender header={header} />
                            {/* An 11px chevron pair at rest, one step above the
                              hairline; sorting collapses it to the direction
                              in play without changing the label's width. */}
                            {sorted === "asc" ? (
                              <ChevronUp
                                className="size-[11px] text-ink-soft"
                                strokeWidth={2}
                                aria-hidden="true"
                              />
                            ) : sorted === "desc" ? (
                              <ChevronDown
                                className="size-[11px] text-ink-soft"
                                strokeWidth={2}
                                aria-hidden="true"
                              />
                            ) : (
                              <ChevronsUpDown
                                className="size-[11px] text-disabled-foreground"
                                strokeWidth={2}
                                aria-hidden="true"
                              />
                            )}
                          </button>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                      </TableHead>
                    )
                  })}
                </TableHeaderRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableEmpty colSpan={table.getAllColumns().length}>
                  {emptyMessage}
                </TableEmpty>
              ) : (
                rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-selected={
                      enableSelection ? row.getIsSelected() : undefined
                    }
                    // The row keeps its `row` role: overriding it with `button`
                    // would take the cell coordinates away from a screen reader.
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={
                      onRowClick
                        ? (event) => {
                            if (ownsItsOwnActivation(event.target)) return
                            onRowClick(row.original)
                          }
                        : undefined
                    }
                    onKeyDown={
                      onRowClick
                        ? (event) => {
                            if (event.key !== "Enter" && event.key !== " ")
                              return
                            if (ownsItsOwnActivation(event.target)) return
                            // Space would scroll the page instead.
                            event.preventDefault()
                            onRowClick(row.original)
                          }
                        : undefined
                    }
                    className={cn(
                      // The hover fill lives on TableRow; a clickable row adds
                      // the cursor and, because it is tabbable, a focus ring.
                      // The outline is inset so the row rules stay unbroken.
                      onRowClick &&
                        "cursor-pointer outline-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground",
                      rowClassName?.(row.original)
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        style={stickyStyle(cell.column.id)}
                        className={cn(
                          // Numeric columns are the right-aligned ones, and the
                          // handoff sets every number tabular.
                          columnAlign(cell.column) === "right" &&
                            "text-right tabular-nums",
                          columnAlign(cell.column) === "center" &&
                            "text-center",
                          columnClass(cell.column),
                          stickyClass(cell.column.id),
                          stickyClass(cell.column.id) &&
                            "group-hover/row:bg-fill-soft"
                        )}
                      >
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {remote?.searchPending ? <TableBusy /> : null}
        </TableFrame>
      </div>
      {tableReplacement ? null : footer}
    </div>
  )
}

/** Reads `meta: { align }` from a column def; numeric columns are right, badges center. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function columnAlign(column: { columnDef: any }): "left" | "center" | "right" {
  const align = column.columnDef.meta?.align
  return align === "right" || align === "center" ? align : "left"
}

/** Reads `meta: { minWidth }` in px; the table floor is the visible sum. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function columnMinWidth(column: { columnDef: any }): number {
  return column.columnDef.meta?.minWidth ?? 0
}

/** Reads `meta: { className }`, applied to both the column's th and tds. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function columnClass(column: { columnDef: any }): string | undefined {
  return column.columnDef.meta?.className
}
