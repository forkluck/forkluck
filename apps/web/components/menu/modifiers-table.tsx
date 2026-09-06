"use client"

import * as React from "react"

import { saveSalesModifierAssociations } from "@/app/(app)/products/actions"
import {
  AlertFlag,
  BlankHeader,
  SortHeader,
  TableEmptyRow,
  sortRows,
  useSortState,
} from "@/components/menu/product-cells"
import { ProductsToolbar } from "@/components/menu/products-toolbar"
import { ProductAssociationPicker } from "@/components/menu/product-association-picker"
import { EmptyState } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TableFrame } from "@/components/ui/table"
import type {
  SalesModifierCatalogList,
  SalesModifierCatalogRecord,
  SalesProductRow,
} from "@/lib/backend/types"
import {
  IGNORE_MODIFIER_ASSOCIATION,
  MIXED_MODIFIER_ASSOCIATION,
  groupModifierAssociations,
} from "@/lib/modifier-association-groups"
import { isModifierCatalogStale } from "@/lib/modifier-catalog-status"
import { NoticeBanner } from "@/components/ui/notice-banner"
import { useCommit } from "@/hooks/use-commit"
import { cn } from "@/lib/utils"

/**
 * Modifiers — the second Products tab.
 *
 * Four columns: the list name, an always-present alert slot, the selections it
 * offers, and how many of them are pointed at a product. A list nobody has
 * associated yet carries the yellow triangle; clicking a row opens the editor
 * where each selection picks the menu product it stands for.
 */
const GRID =
  "grid-cols-[minmax(0,245px)_40px_minmax(0,1fr)_116px] gap-3 min-w-[620px]"

const HISTORICAL_ID = "historical-unassigned"

type SortKey = "name" | "details" | "associated"

type ModifierRow = {
  list: SalesModifierCatalogList
  name: string
  details: string
  associated: number
  total: number
  haystack: string
}

type RecordDecision = {
  providerAccountId: string
  matchKey: string
  externalName: string
  decision: "associate" | "unassociate" | "ignore"
  productId: string | null
}

function buildRow(list: SalesModifierCatalogList): ModifierRow {
  const groups = groupModifierAssociations(list)
  const associated = groups.filter(
    (group) =>
      group.initialSelection &&
      group.initialSelection !== MIXED_MODIFIER_ASSOCIATION &&
      !group.needsNormalization
  ).length
  const details =
    groups.map((group) => group.name).join(", ") ||
    (list.modifierType === "text"
      ? "Customer-entered text"
      : "No modifier items")
  return {
    list,
    name: list.name,
    details,
    associated,
    total: groups.length,
    haystack: `${list.name} ${details}`.toLocaleLowerCase(),
  }
}

export function ModifiersTable({
  lists,
  unassignedRecords,
  products,
  squareConnected,
  squareNeedsReconnect,
  squareSyncedAt,
  squareSalesSyncedAt,
}: {
  lists: SalesModifierCatalogList[]
  unassignedRecords: SalesModifierCatalogRecord[]
  products: SalesProductRow[]
  squareConnected: boolean
  squareNeedsReconnect: boolean
  squareSyncedAt: string | null
  squareSalesSyncedAt: string | null
}) {
  const [query, setQuery] = React.useState("")
  const deferredQuery = React.useDeferredValue(query)
  const [openList, setOpenList] =
    React.useState<SalesModifierCatalogList | null>(null)
  const [associations, setAssociations] = React.useState<
    Record<string, string>
  >({})
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const commit = useCommit({
    onSaveState: (state) => setPending(state === "saving"),
  })
  const { sort, toggle, directionFor } = useSortState<SortKey>()

  const singleProducts = React.useMemo(
    () => products.filter((product) => product.isActive),
    [products]
  )
  const catalogStale = isModifierCatalogStale({
    squareConnected,
    squareSyncedAt,
    squareSalesSyncedAt,
  })
  // Existing associations can point at a product that is no longer offered as
  // a choice, so the picker resolves the current one against every product.
  const productsById = React.useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  )

  const allRows = React.useMemo(() => {
    const rows = lists.map(buildRow)
    if (unassignedRecords.length) {
      // Records whose Square list is no longer known still need a decision,
      // so they get one row of their own at the end of the list.
      rows.push(
        buildRow({
          id: HISTORICAL_ID,
          channel: unassignedRecords[0]?.channel ?? "square",
          providerAccountId: unassignedRecords[0]?.providerAccountId ?? "",
          externalObjectId: "",
          name: "Removed modifiers",
          modifierType: "historical",
          selectionType: "multiple",
          allowQuantities: false,
          minSelected: 0,
          maxSelected: 0,
          mappedCount: unassignedRecords.filter((record) => record.productId)
            .length,
          options: [],
          records: unassignedRecords,
        })
      )
    }
    return rows
  }, [lists, unassignedRecords])

  const rows = React.useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase()
    const filtered = needle
      ? allRows.filter((row) => row.haystack.includes(needle))
      : allRows
    return sortRows<ModifierRow, SortKey>(filtered, sort, {
      name: (row) => row.name,
      details: (row) => row.details,
      associated: (row) => row.associated,
    })
  }, [allRows, deferredQuery, sort])

  const openDetails = React.useCallback((list: SalesModifierCatalogList) => {
    setError(null)
    setOpenList(list)
    setAssociations(
      Object.fromEntries(
        groupModifierAssociations(list).map((group) => [
          group.id,
          group.initialSelection,
        ])
      )
    )
  }, [])

  const associationGroups = React.useMemo(
    () => (openList ? groupModifierAssociations(openList) : []),
    [openList]
  )

  const changedGroups = React.useMemo(
    () =>
      associationGroups.filter((group) => {
        const selection = associations[group.id] ?? group.initialSelection
        if (selection === MIXED_MODIFIER_ASSOCIATION) return false
        if (selection === IGNORE_MODIFIER_ASSOCIATION) {
          return (
            group.records.length > 0 ||
            group.options.some((option) => option.productId !== null)
          )
        }
        const productId = selection || null
        return (
          group.needsNormalization ||
          group.options.some((option) => option.productId !== productId) ||
          group.records.some((record) =>
            productId
              ? record.productId !== productId
              : record.variantId !== null
          )
        )
      }),
    [associationGroups, associations]
  )

  const saveAssociations = React.useCallback(() => {
    if (!openList || !changedGroups.length) return
    void commit({
      domain: "workspace:modifier-associations",
      // Nothing goes on screen ahead of the server: the dialog is the value.
      apply: () => setError(null),
      revert: () => {},
      write: async () => {
        const result = await saveSalesModifierAssociations({
          options: changedGroups.flatMap((group) => {
            const selection = associations[group.id] ?? group.initialSelection
            const productId =
              selection === IGNORE_MODIFIER_ASSOCIATION
                ? null
                : selection || null
            return group.options
              .filter((option) => option.productId !== productId)
              .map((option) => ({ optionId: option.id, productId }))
          }),
          records: changedGroups.flatMap<RecordDecision>((group) => {
            const selection = associations[group.id] ?? group.initialSelection
            if (selection === IGNORE_MODIFIER_ASSOCIATION) {
              return group.records.map((record) => ({
                providerAccountId: record.providerAccountId,
                matchKey: record.matchKey,
                externalName: record.name,
                decision: "ignore" as const,
                productId: null,
              }))
            }
            const productId = selection || null
            return group.records.flatMap<RecordDecision>((record) => {
              if (productId && record.productId !== productId) {
                return [
                  {
                    providerAccountId: record.providerAccountId,
                    matchKey: record.matchKey,
                    externalName: record.name,
                    decision: "associate" as const,
                    productId,
                  },
                ]
              }
              if (!productId && record.variantId) {
                return [
                  {
                    providerAccountId: record.providerAccountId,
                    matchKey: record.matchKey,
                    externalName: record.name,
                    decision: "unassociate" as const,
                    productId: null,
                  },
                ]
              }
              return []
            })
          }),
        })
        return "error" in result ? result : { ok: true as const }
      },
    }).then((failure) => {
      if (failure) setError(failure.message)
      else setOpenList(null)
    })
  }, [associations, changedGroups, commit, openList])

  return (
    <>
      <ProductsToolbar
        query={query}
        onQueryChange={setQuery}
        searchLabel="Search modifier lists"
      />

      {error && !openList ? (
        <p role="alert" className="mb-3 text-base text-destructive">
          {error}
        </p>
      ) : null}

      {catalogStale ? (
        <NoticeBanner>
          {squareNeedsReconnect
            ? "Modifier lists are out of date. Reconnect Square in Settings to bring them back."
            : "Modifier lists are behind your latest Square sync. Refresh to bring them up to date."}
        </NoticeBanner>
      ) : null}

      {allRows.length === 0 ? (
        <EmptyState
          title="No Square modifier lists"
          description="Modifier lists are imported automatically during the regular Square sync."
        />
      ) : (
        <TableFrame className="overflow-x-auto">
          <div
            className={cn(
              "grid h-12 items-center border-b border-border text-2xs font-medium text-ink-soft",
              GRID
            )}
          >
            <SortHeader
              direction={directionFor("name")}
              onClick={() => toggle("name")}
            >
              Name
            </SortHeader>
            <BlankHeader />
            <SortHeader
              direction={directionFor("details")}
              onClick={() => toggle("details")}
            >
              Details
            </SortHeader>
            <SortHeader
              align="right"
              direction={directionFor("associated")}
              onClick={() => toggle("associated")}
            >
              Associated
            </SortHeader>
          </div>

          {rows.length === 0 ? (
            <TableEmptyRow>No modifier lists match that search.</TableEmptyRow>
          ) : (
            rows.map((row) => (
              <div
                key={row.list.id}
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  // The alert flag owns its own click.
                  if ((event.target as HTMLElement).closest("a,button")) return
                  openDetails(row.list)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    openDetails(row.list)
                  }
                }}
                className={cn(
                  "group/row grid h-[58px] cursor-pointer items-center border-b border-muted outline-none last:border-b-0 hover:bg-fill-soft focus-visible:bg-fill-soft",
                  GRID
                )}
              >
                <span className="truncate text-md text-foreground">
                  {row.name}
                </span>
                {row.total > 0 && row.associated === 0 ? (
                  <span className="flex items-center">
                    <AlertFlag label="Not associated" width={172} />
                  </span>
                ) : (
                  <span />
                )}
                <span className="min-w-0 truncate text-base text-muted-foreground">
                  {row.details}
                </span>
                <span className="text-right text-base text-muted-foreground tabular-nums">
                  {row.total ? `${row.associated} of ${row.total}` : "—"}
                </span>
              </div>
            ))
          )}
        </TableFrame>
      )}

      <Dialog
        open={openList !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setOpenList(null)
            setError(null)
          }
        }}
      >
        <DialogContent
          size="lg"
          // One fixed height: a save error, or a longer list, moves the rows
          // inside, never the dialog. Only the selection list scrolls.
          className="top-12 flex h-[min(640px,calc(100dvh-96px))] translate-y-0 flex-col overflow-hidden pb-[22px] [--dialog-px:28px] [--dialog-py:26px]"
        >
          <DialogHeader>
            <DialogTitle className="text-xl">
              {openList?.name ?? "Modifier list"}
            </DialogTitle>
          </DialogHeader>

          {associationGroups.length ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
              {/* Each row stacks on a phone, so the column labels go with it. */}
              <div className="hidden shrink-0 grid-cols-[minmax(0,1fr)_120px_minmax(0,240px)] gap-3 border-b border-muted px-4 py-3.5 text-sm font-medium text-foreground md:grid">
                <span>Selection</span>
                <span className="text-right">Sales history</span>
                <span>Counts as</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {associationGroups.map((group) => {
                  const selection =
                    associations[group.id] ?? group.initialSelection
                  return (
                    <div
                      key={group.id}
                      className="flex flex-col gap-2 border-b border-muted px-4 py-2.5 last:border-b-0 md:grid md:grid-cols-[minmax(0,1fr)_120px_minmax(0,240px)] md:items-center md:gap-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-md text-foreground">
                          {group.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-faint">
                          {group.squareRecordCount} Square{" "}
                          {group.squareRecordCount === 1 ? "record" : "records"}
                        </span>
                      </span>
                      <span className="text-base text-muted-foreground tabular-nums md:text-right">
                        {group.usageCount
                          ? `${group.usageCount} ${group.usageCount === 1 ? "selection" : "selections"}`
                          : "—"}
                      </span>
                      <ProductAssociationPicker
                        products={singleProducts}
                        value={selection}
                        currentProduct={productsById.get(selection)}
                        allowIgnore={group.records.length > 0}
                        ariaLabel={`Menu product for ${group.name}`}
                        onValueChange={(value) =>
                          setAssociations((current) => ({
                            ...current,
                            [group.id]: value,
                          }))
                        }
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border px-4 py-10 text-center text-base text-muted-foreground">
              {openList?.modifierType === "text"
                ? "This is a customer-entered text modifier, so there is no product to associate."
                : "Square did not return any modifier items in this list."}
            </div>
          )}

          {error ? (
            <p role="alert" className="text-base text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter className="mt-1.5">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setOpenList(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!changedGroups.length}
              pending={pending}
              onClick={saveAssociations}
            >
              Save associations
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
