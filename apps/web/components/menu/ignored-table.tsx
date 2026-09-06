"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronRight, ChevronUp } from "lucide-react"

import {
  unignoreSalesModifiers,
  unignoreSalesSkus,
} from "@/app/(app)/products/actions"
import {
  BlankHeader,
  SortHeader,
  TableEmptyRow,
  sortRows,
  useSortState,
} from "@/components/menu/product-cells"
import { ProductsToolbar } from "@/components/menu/products-toolbar"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { GuardedLink } from "@/components/navigation-blocker"
import { formatFullDate } from "@/lib/datetime"
import { EmptyState } from "@/components/ui/page"
import { Button, buttonVariants } from "@/components/ui/button"
import { FilterPill } from "@/components/ui/filter-pill"
import { TableFrame } from "@/components/ui/table"
import { useToast } from "@/components/ui/toast"
import { useGroupOpenState } from "@/hooks/use-group-open-state"
import type {
  SalesIgnoredIdentity,
  SalesIgnoredItem,
  SalesIgnoredModifier,
} from "@/lib/backend/types"
import { formatCents, quantityFormat } from "@/lib/money"
import { channelLabel } from "@/lib/sales-identity"
import { cn } from "@/lib/utils"

/**
 * Ignored — the third Products tab. Rows sit in a collapsible group per
 * channel, the way Catalog groups its queue, so the columns are item, SKU,
 * units, net sales, last sale, and a ghost Restore that puts the identity back
 * in Catalog. Ignored rows keep their sales history, so every number here is
 * real; only the attribution is paused.
 */
const GRID =
  "grid-cols-[minmax(0,245px)_minmax(0,1fr)_96px_108px_116px_78px] gap-3 min-w-[823px]"

type SortKey = "item" | "sku" | "units" | "net" | "last"

function displayName(row: SalesIgnoredIdentity) {
  return (
    row.externalName ||
    (row.identityKind === "modifier" ? "Unnamed modifier" : "Unnamed item")
  )
}

export function IgnoredTable({
  items,
  modifiers,
  itemCount,
  modifierCount,
}: {
  items: SalesIgnoredItem[]
  modifiers: SalesIgnoredModifier[]
  itemCount: number
  modifierCount: number
}) {
  const toast = useToast()
  const { currencyCode, timezone } = useBusinessSettings()
  const [query, setQuery] = React.useState("")
  const [kind, setKind] = React.useState<"all" | "item" | "modifier">("all")
  const [channel, setChannel] = React.useState<"all" | "shopify" | "square">(
    "all"
  )
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const { sort, toggle, directionFor } = useSortState<SortKey>()
  const { openGroups, setGroupOpen } = useGroupOpenState("fl.ignored.groups")

  const rows = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const source: SalesIgnoredIdentity[] =
      kind === "item"
        ? items
        : kind === "modifier"
          ? modifiers
          : [...items, ...modifiers]
    const filtered = source.filter(
      (row) =>
        (channel === "all" || row.channel === channel) &&
        (!needle ||
          `${row.externalName} ${row.externalVariantTitle} ${row.sku}`
            .toLocaleLowerCase()
            .includes(needle))
    )
    return sortRows<SalesIgnoredIdentity, SortKey>(filtered, sort, {
      item: (row) => displayName(row),
      sku: (row) => row.sku,
      units: (row) => row.quantity,
      net: (row) => row.netSalesCents,
      last: (row) => row.lastSoldAt?.getTime() ?? 0,
    })
  }, [channel, items, kind, modifiers, query, sort])

  const groups = React.useMemo(
    () =>
      (["shopify", "square"] as const)
        .map((value) => ({
          channel: value,
          rows: rows.filter((row) => row.channel === value),
        }))
        .filter((group) => group.rows.length),
    [rows]
  )

  // Two groups at most, so they start open; search forces them open because a
  // match behind a collapsed header reads as no match at all.
  const isOpen = (id: string) =>
    query.trim() ? true : (openGroups[id] ?? true)

  const restore = async (row: SalesIgnoredIdentity) => {
    setPendingId(row.id)
    const input = [
      {
        channel: row.channel,
        providerAccountId: row.providerAccountId,
        matchKey: row.matchKey,
      },
    ]
    const result =
      row.identityKind === "modifier"
        ? await unignoreSalesModifiers(input)
        : await unignoreSalesSkus(input)
    setPendingId(null)
    if ("error" in result) {
      toast.add({
        title: "Couldn’t restore that item",
        description: result.error,
        type: "error",
      })
      return
    }
    toast.add({
      title: `${displayName(row)} restored`,
      description: "It is back in Catalog, waiting for a decision.",
    })
  }

  const total = itemCount + modifierCount
  const shown =
    kind === "item"
      ? items.length
      : kind === "modifier"
        ? modifiers.length
        : items.length + modifiers.length
  const capped =
    (kind === "item"
      ? itemCount
      : kind === "modifier"
        ? modifierCount
        : total) > shown

  return (
    <>
      <ProductsToolbar
        query={query}
        onQueryChange={setQuery}
        searchLabel="Search ignored sales"
        filter={
          <>
            <FilterPill
              label="Type"
              value={kind}
              options={[
                { value: "all", label: "All" },
                { value: "item", label: "Items" },
                { value: "modifier", label: "Modifiers" },
              ]}
              onSelect={setKind}
            />
            <FilterPill
              label="Channel"
              value={channel}
              options={[
                { value: "all", label: "All" },
                { value: "shopify", label: channelLabel("shopify") },
                { value: "square", label: channelLabel("square") },
              ]}
              onSelect={setChannel}
            />
          </>
        }
        action={
          <GuardedLink
            href="/products/new"
            className={cn(buttonVariants(), "shrink-0")}
          >
            Add product
          </GuardedLink>
        }
      />

      {total === 0 ? (
        <EmptyState
          title="Nothing ignored"
          description="Items and modifiers you ignore from Catalog land here with their sales history intact. Restore one whenever you are ready to give it a product."
        />
      ) : (
        <>
          {groups.length === 0 ? (
            <TableFrame>
              <TableEmptyRow>No ignored sales match that filter.</TableEmptyRow>
            </TableFrame>
          ) : (
            <div className="flex flex-col gap-2.5">
              {groups.map((group) => {
                const open = isOpen(group.channel)
                return (
                  <div
                    key={group.channel}
                    className="overflow-hidden rounded-xl border border-border"
                  >
                    <div className="flex h-[52px] items-center gap-2.5 px-3.5">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={open ? "Collapse group" : "Expand group"}
                        onClick={() => setGroupOpen(group.channel, !open)}
                        className="flex size-7 flex-none items-center justify-center rounded-md border border-transparent text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:border-foreground"
                      >
                        {open ? (
                          <ChevronUp
                            className="size-3.5"
                            strokeWidth={2}
                            aria-hidden="true"
                          />
                        ) : (
                          <ChevronRight
                            className="size-3.5"
                            strokeWidth={2}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                      <span className="truncate text-md font-medium text-foreground tabular-nums">
                        {channelLabel(group.channel)} · {group.rows.length}{" "}
                        {group.rows.length === 1 ? "row" : "rows"}
                      </span>
                    </div>

                    {open ? (
                      <div className="overflow-x-auto border-t border-muted">
                        <div
                          className={cn(
                            "grid h-11 items-center border-b border-border px-3.5 text-2xs font-medium text-ink-soft",
                            GRID
                          )}
                        >
                          <SortHeader
                            direction={directionFor("item")}
                            onClick={() => toggle("item")}
                          >
                            Item
                          </SortHeader>
                          <SortHeader
                            direction={directionFor("sku")}
                            onClick={() => toggle("sku")}
                          >
                            SKU
                          </SortHeader>
                          <SortHeader
                            align="right"
                            direction={directionFor("units")}
                            onClick={() => toggle("units")}
                          >
                            Units
                          </SortHeader>
                          <SortHeader
                            align="right"
                            direction={directionFor("net")}
                            onClick={() => toggle("net")}
                          >
                            Net sales
                          </SortHeader>
                          <SortHeader
                            align="right"
                            direction={directionFor("last")}
                            onClick={() => toggle("last")}
                          >
                            Last sale
                          </SortHeader>
                          <BlankHeader />
                        </div>

                        {group.rows.map((row) => (
                          <div
                            key={`${row.identityKind}:${row.id}`}
                            className={cn(
                              "group/row grid h-[58px] items-center border-b border-muted px-3.5 last:border-b-0 hover:bg-fill-soft",
                              GRID
                            )}
                          >
                            <span
                              className="truncate text-md text-foreground"
                              title={row.externalVariantTitle || undefined}
                            >
                              {displayName(row)}
                            </span>
                            <span className="truncate text-base text-muted-foreground tabular-nums">
                              {row.sku || "—"}
                            </span>
                            <span className="text-right text-base text-muted-foreground tabular-nums">
                              {quantityFormat.format(row.quantity)}
                            </span>
                            <span className="text-right text-base text-muted-foreground tabular-nums">
                              {formatCents(
                                row.netSalesCents,
                                row.currencyCode || currencyCode
                              )}
                            </span>
                            <span className="text-right text-base text-muted-foreground tabular-nums">
                              {row.lastSoldAt
                                ? formatFullDate(row.lastSoldAt, timezone)
                                : "—"}
                            </span>
                            {row.source === "rule" ? (
                              // The next sweep would write this row straight
                              // back, so the way out is the rule, not the row.
                              <Link
                                href="/integrations/sales/mapping/rules"
                                title="Ignored by an auto-ignore rule"
                                className="justify-self-end text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
                              >
                                Rule
                              </Link>
                            ) : (
                              <Button
                                variant="outline"
                                className="justify-self-end"
                                disabled={pendingId !== null}
                                onClick={() => void restore(row)}
                              >
                                {pendingId === row.id
                                  ? "Restoring…"
                                  : "Restore"}
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}

          {capped ? (
            <p className="mt-3 text-xs text-faint">
              Showing the first {shown}. Restore some to see the rest.
            </p>
          ) : null}
        </>
      )}
    </>
  )
}
