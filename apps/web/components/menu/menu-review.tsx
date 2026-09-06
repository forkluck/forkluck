"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ChevronRight, ChevronUp } from "lucide-react"

import {
  ignoreSalesCategory,
  ignoreSalesSkus,
} from "@/app/(app)/products/actions"
import { IdentityLinesDialog } from "@/components/menu/identity-lines-dialog"
import {
  MenuItemDialog,
  type MenuRecipeOption,
} from "@/components/menu/menu-item-dialog"
import { ownsItsOwnActivation } from "@/components/ui/data-table"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { GuardedLink } from "@/components/navigation-blocker"
import { formatFullDate } from "@/lib/datetime"
import { productHref, productPublicId } from "@/lib/product-href"
import {
  SortHeader,
  sortRows,
  useSortState,
} from "@/components/menu/product-cells"
import { ProductsToolbar } from "@/components/menu/products-toolbar"
import { EmptyState } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { FilterPill } from "@/components/ui/filter-pill"
import { TableBusy } from "@/components/ui/table"
import { useBrowseUrl } from "@/hooks/use-browse-url"
import { useGroupOpenState } from "@/hooks/use-group-open-state"
import type {
  SalesProductRow,
  SalesReviewCategory,
  SalesReviewItem,
} from "@/lib/backend/types"
import { formatCents, quantityFormat } from "@/lib/money"
import {
  channelLabel,
  salesIdentityKey,
  suggestedProduct,
} from "@/lib/sales-identity"
import {
  groupReviewItemsByCategory,
  reviewGroupSummary,
} from "@/lib/sales-review-groups"
import { cn } from "@/lib/utils"

/**
 * Catalog — every unlinked Square and Shopify identity, whether it has sold
 * yet or not. Linking is always an explicit merchant decision.
 */
const GRID =
  "grid-cols-[26px_minmax(0,1fr)_96px_92px_110px_72px_104px_108px_152px] min-w-[960px]"

function ignorePayload(item: SalesReviewItem) {
  return {
    channel: item.channel,
    providerAccountId: item.providerAccountId,
    matchKey: item.matchKey,
    sku: item.sku,
    externalName: item.itemName,
    externalVariantTitle: item.externalVariantTitle,
  }
}

type SortKey = "item" | "sku" | "channel" | "source" | "sold" | "net" | "last"

function orderSourceLabel(sources: string[]) {
  return sources.join(", ")
}

/**
 * Mirror the backend's `casefold()` closely enough that Linked search agrees
 * with Review search: JS lowercasing leaves `ß` alone, Python folds it to ss.
 */
function foldForSearch(value: string): string {
  return value.toLowerCase().replaceAll("ß", "ss")
}

/** URL-driven catalog views; "review" is the default and omits the param. */
export type CatalogTab = "all" | "linked" | "review" | "shopify" | "square"

const TAB_LABELS: Record<CatalogTab, string> = {
  all: "All",
  linked: "Linked",
  review: "Review",
  shopify: "Shopify Only",
  square: "Square Only",
}

type IgnoreTarget =
  | { kind: "rows"; rows: SalesReviewItem[]; title: string; body: string }
  | {
      kind: "category"
      channel: "square" | "shopify"
      providerAccountIds: string[]
      category: string
      soldOnly: boolean
      title: string
      body: string
    }

export function MenuReview({
  items,
  categories = [],
  reviewCount,
  reviewMatchCount,
  query,
  tab,
  menuItems,
  recipes,
}: {
  /** Capped at 200 rows per category; `reviewCount` is the true total. */
  items: SalesReviewItem[]
  categories?: SalesReviewCategory[]
  reviewCount: number
  reviewMatchCount: number
  query: string
  tab: CatalogTab
  menuItems: SalesProductRow[]
  recipes: MenuRecipeOption[]
}) {
  const browse = useBrowseUrl({ query })
  const router = useRouter()
  // The View pill navigates; it spins and the rows wash out until the other
  // view arrives, the same way a search does.
  const [tabPending, startTab] = React.useTransition()
  const busy = browse.isPending || tabPending
  const { currencyCode, timezone } = useBusinessSettings()
  const [trackTarget, setTrackTarget] = React.useState<SalesReviewItem | null>(
    null
  )
  const [trackProduct, setTrackProduct] =
    React.useState<SalesProductRow | null>(null)
  const [ignoreTarget, setIgnoreTarget] = React.useState<IgnoreTarget | null>(
    null
  )
  const [detailTarget, setDetailTarget] =
    React.useState<SalesReviewItem | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  // Server refreshes are asynchronous. Keep confirmed ignores out of the
  // current view immediately, then let the refreshed payload become truth.
  const [dismissed, setDismissed] = React.useState<Set<string>>(() => new Set())
  // Groups all start collapsed; the ones the merchant opens stay open for
  // the session, per tab.
  const { openGroups, setGroupOpen } = useGroupOpenState(
    `fl.catalog.groups.${tab}`
  )
  // One sort applies to every group at once; the column headers repeat per
  // group but they are the same six columns describing the same rows.
  const { sort, toggle, directionFor } = useSortState<SortKey>()

  const sortGroup = React.useCallback(
    (rows: SalesReviewItem[]) =>
      sortRows<SalesReviewItem, SortKey>(rows, sort, {
        item: (row) => row.itemName,
        sku: (row) => row.sku,
        channel: (row) => row.channel,
        source: (row) => orderSourceLabel(row.orderSources),
        sold: (row) => row.quantity,
        net: (row) => row.netSalesCents,
        last: (row) => row.lastSoldAt?.getTime() ?? 0,
      }),
    [sort]
  )

  // "Shopify Only" / "Square Only" filter the Review rows by their source
  // channel; the data already names it, so the tabs cost nothing.
  const channelFilter = tab === "shopify" || tab === "square" ? tab : null
  const showReview = tab !== "linked"
  const showLinked = tab === "all" || tab === "linked"

  const visibleItems = React.useMemo(() => {
    // Django owns review search so it can inspect the complete queue before
    // applying the 200-row display cap and use one Unicode normalization rule.
    // The browser only hides rows that have just been dismissed locally.
    return items.filter(
      (item) =>
        !dismissed.has(salesIdentityKey(item)) &&
        (channelFilter === null || item.channel === channelFilter)
    )
  }, [channelFilter, dismissed, items])

  const visibleCategories = React.useMemo(
    () =>
      channelFilter === null
        ? categories
        : categories.filter((category) => category.channel === channelFilter),
    [categories, channelFilter]
  )
  const groups = React.useMemo(
    () => groupReviewItemsByCategory(visibleItems, visibleCategories),
    [visibleCategories, visibleItems]
  )
  const visibleTotal = React.useMemo(() => {
    if (!visibleCategories.length) return query ? reviewMatchCount : reviewCount
    return visibleCategories.reduce(
      (sum, category) => sum + category.keyCount,
      0
    )
  }, [visibleCategories, query, reviewCount, reviewMatchCount])

  const allLinkedRows = React.useMemo(
    () =>
      menuItems
        .flatMap((product) =>
          product.variants
            .filter((variant) => variant.identityKind === "item")
            .map((variant) => ({
              productLabel: product.name,
              productPublicId: productPublicId(product),
              variant,
              haystack: [
                foldForSearch(product.name),
                foldForSearch(variant.externalName),
                foldForSearch(variant.sku),
              ],
            }))
        )
        .sort(
          (a, b) =>
            a.productLabel.localeCompare(b.productLabel) ||
            a.variant.channel.localeCompare(b.variant.channel)
        ),
    [menuItems]
  )

  const deferredSearchValue = React.useDeferredValue(browse.searchValue)
  const linkedRows = React.useMemo(() => {
    const search = foldForSearch(deferredSearchValue.trim())
    if (!search) return allLinkedRows
    return allLinkedRows.filter((row) =>
      row.haystack.some((field) => field.includes(search))
    )
  }, [allLinkedRows, deferredSearchValue])

  const tabHref = (next: CatalogTab) => {
    const params = new URLSearchParams()
    if (next !== "review") params.set("tab", next)
    if (query) params.set("q", query)
    const qs = params.toString()
    return qs
      ? `/integrations/sales/mapping?${qs}`
      : "/integrations/sales/mapping"
  }

  // Search forces every group open — a match hidden behind a collapsed
  // header reads as no match at all.
  const isOpen = (id: string) =>
    browse.searchValue.trim() ? true : (openGroups[id] ?? false)

  // Review rows are POS document money, so each is formatted with the code it
  // was recorded in. The workspace code fills in for a row with no sales and
  // for the group rollups, which span identities and so have no single code.
  const money = React.useCallback(
    (cents: number, rowCurrencyCode = "") =>
      formatCents(cents, rowCurrencyCode || currencyCode),
    [currencyCode]
  )

  // Local-first: the rows leave the queue the moment the merchant confirms,
  // the dialog closes, and the server catches up in the background. On error
  // the same keys come back and the banner says why. The revalidated payload
  // is still the eventual truth — `dismissed` only bridges the gap.
  const confirmIgnore = async () => {
    if (!ignoreTarget) return
    const target = ignoreTarget
    const keys = new Set<string>()
    if (target.kind === "rows") {
      for (const row of target.rows) keys.add(salesIdentityKey(row))
    } else {
      for (const item of items) {
        if (
          item.channel === target.channel &&
          target.providerAccountIds.includes(item.providerAccountId) &&
          item.category === target.category
        ) {
          keys.add(salesIdentityKey(item))
        }
      }
    }
    setError(null)
    setDismissed((current) => new Set([...current, ...keys]))
    setSelected(new Set())
    setIgnoreTarget(null)
    const result =
      target.kind === "rows"
        ? await ignoreSalesSkus(target.rows.map(ignorePayload))
        : await ignoreSalesCategory({
            channel: target.channel,
            providerAccountIds: target.providerAccountIds,
            category: target.category,
            soldOnly: target.soldOnly,
          })
    if ("error" in result) {
      setError(result.error)
      setDismissed((current) => {
        const next = new Set(current)
        for (const key of keys) next.delete(key)
        return next
      })
    }
  }

  const toggleRow = (key: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })

  return (
    <>
      {error ? (
        <p role="alert" className="mb-3 text-base text-destructive">
          {error}
        </p>
      ) : null}

      <ProductsToolbar
        query={browse.searchValue}
        onQueryChange={browse.onSearchValueChange}
        searchLabel="Search items"
        filter={
          <FilterPill
            label="View"
            value={tab}
            options={(Object.keys(TAB_LABELS) as CatalogTab[]).map((key) => ({
              value: key,
              label: TAB_LABELS[key],
            }))}
            pending={tabPending}
            onSelect={(next) =>
              startTab(() => router.push(tabHref(next), { scroll: false }))
            }
          />
        }
      />

      {showLinked ? (
        linkedRows.length ? (
          <div className="relative mb-4 overflow-hidden rounded-xl border border-border">
            {busy ? <TableBusy /> : null}
            <div className="flex h-[52px] items-center px-3.5 text-md font-medium tabular-nums">
              Linked · {linkedRows.length}{" "}
              {linkedRows.length === 1 ? "variant" : "variants"}
            </div>
            <div className="overflow-x-auto border-t border-muted">
              <div className="grid min-w-[640px] grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_92px]">
                <div className="col-span-full grid grid-cols-subgrid border-b border-muted px-3.5 py-2 text-xs text-muted-foreground">
                  <span>Product</span>
                  <span>Provider item</span>
                  <span>SKU</span>
                  <span>Channel</span>
                </div>
                {linkedRows.map(
                  ({ productLabel, productPublicId, variant }) => (
                    <div
                      key={variant.id}
                      className="col-span-full grid grid-cols-subgrid items-center border-b border-muted px-3.5 py-2 last:border-b-0"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <GuardedLink
                          href={productHref({ publicId: productPublicId })}
                          className="truncate rounded-sm text-base outline-none hover:underline focus-visible:underline"
                        >
                          {productLabel}
                        </GuardedLink>
                        {variant.attributionPercent !== null &&
                        variant.attributionPercent !== 100 ? (
                          <span
                            title={`${100 - variant.attributionPercent}% of this sale is unattributed`}
                            className="flex-none rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground tabular-nums"
                          >
                            {variant.attributionPercent}%
                          </span>
                        ) : null}
                      </span>
                      <span className="truncate text-base text-muted-foreground">
                        {variant.externalName}
                        {variant.externalVariantTitle
                          ? ` · ${variant.externalVariantTitle}`
                          : ""}
                      </span>
                      <span className="truncate text-base text-muted-foreground tabular-nums">
                        {variant.sku || "—"}
                      </span>
                      <span className="text-base text-muted-foreground">
                        {channelLabel(variant.channel)}
                      </span>
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        ) : tab === "linked" ? (
          <EmptyState
            title="Nothing linked yet"
            description="Track an item from Review and its variant appears here."
          />
        ) : null
      ) : null}

      {!showReview ? null : groups.length === 0 && busy ? (
        // A search still in flight has reached no verdict, so hold the
        // spinner rather than flash an empty state the next payload undoes.
        <div className="relative min-h-32">
          <TableBusy />
        </div>
      ) : groups.length === 0 ? (
        browse.searchValue.trim() ? (
          <EmptyState
            title="No items match your search"
            description="Try a different name, SKU, or category."
          />
        ) : (
          <EmptyState
            title={
              channelFilter
                ? `No unlinked ${channelLabel(channelFilter)} items`
                : "Your catalog is fully linked"
            }
            description="Every catalog item has a product or has been ignored. New provider items appear after the next sync."
          />
        )
      ) : (
        <div className="relative flex flex-col gap-2.5">
          {busy ? <TableBusy /> : null}
          {groups.map((group) => {
            const open = isOpen(group.id)
            const visibleKeyCount = group.totalKeyCount
            const hidden = visibleKeyCount - group.items.length
            const groupSelection = group.items.filter((item) =>
              selected.has(salesIdentityKey(item))
            )
            return (
              <div
                key={group.id}
                className="overflow-hidden rounded-xl border border-border"
              >
                <div className="flex h-[52px] items-center gap-2.5 px-3.5">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={open ? "Collapse group" : "Expand group"}
                    onClick={() => setGroupOpen(group.id, !open)}
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
                    {reviewGroupSummary(
                      { ...group, totalKeyCount: visibleKeyCount },
                      money
                    )}
                  </span>
                  <span className="flex-none text-xs text-faint">
                    {channelLabel(group.channel)}
                  </span>
                  {hidden > 0 ? (
                    <span className="flex-none text-xs text-faint tabular-nums">
                      showing {group.items.length}
                    </span>
                  ) : null}
                  <Button
                    variant="outline"
                    className="ml-auto"
                    onClick={() =>
                      setIgnoreTarget(
                        groupSelection.length
                          ? {
                              kind: "rows",
                              rows: groupSelection,
                              title:
                                groupSelection.length === 1
                                  ? "Ignore this item?"
                                  : `Ignore ${groupSelection.length} items?`,
                              body: "They drop out of Catalog and their sales stop counting toward any product. You can restore them from the Ignored tab.",
                            }
                          : {
                              kind: "category",
                              channel: group.channel,
                              providerAccountIds: group.providerAccountIds,
                              category: group.category,
                              soldOnly: false,
                              title: `Ignore all of ${group.label}?`,
                              body: `All ${visibleKeyCount} unlinked items in this ${group.channel === "shopify" ? "Shopify type" : "Square category"} drop out of Catalog, including any not shown. Their sales stop counting toward any product, and you can restore them from the Ignored tab.`,
                            }
                      )
                    }
                  >
                    {groupSelection.length
                      ? `Ignore ${groupSelection.length}`
                      : "Ignore all"}
                  </Button>
                </div>

                {open ? (
                  <div className="overflow-x-auto border-t border-muted">
                    <div
                      className={cn(
                        "grid h-11 items-center border-b border-border px-3.5 text-2xs font-medium text-ink-soft",
                        GRID
                      )}
                    >
                      <Checkbox
                        checked={
                          group.items.length > 0 &&
                          groupSelection.length === group.items.length
                        }
                        indeterminate={
                          groupSelection.length > 0 &&
                          groupSelection.length < group.items.length
                        }
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current)
                            for (const item of group.items) {
                              if (checked === true)
                                next.add(salesIdentityKey(item))
                              else next.delete(salesIdentityKey(item))
                            }
                            return next
                          })
                        }
                        aria-label={`Select every item in ${group.label}`}
                      />
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
                        direction={directionFor("channel")}
                        onClick={() => toggle("channel")}
                      >
                        Channel
                      </SortHeader>
                      <SortHeader
                        direction={directionFor("source")}
                        onClick={() => toggle("source")}
                      >
                        Source
                      </SortHeader>
                      <SortHeader
                        align="right"
                        direction={directionFor("sold")}
                        onClick={() => toggle("sold")}
                      >
                        Items sold
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
                        Last sold
                      </SortHeader>
                      <span />
                    </div>

                    {sortGroup(group.items).map((item) => (
                      <div
                        key={salesIdentityKey(item)}
                        // Clickable-row conventions from DataTable: inner
                        // controls keep their own clicks, Enter/Space work,
                        // and the focus outline is inset.
                        tabIndex={0}
                        onClick={(event) => {
                          if (ownsItsOwnActivation(event.target)) return
                          setDetailTarget(item)
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return
                          if (ownsItsOwnActivation(event.target)) return
                          event.preventDefault()
                          setDetailTarget(item)
                        }}
                        className={cn(
                          "grid h-[52px] cursor-pointer items-center border-b border-muted px-3.5 outline-none last:border-b-0 hover:bg-fill-soft focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground",
                          GRID
                        )}
                      >
                        <Checkbox
                          checked={selected.has(salesIdentityKey(item))}
                          onCheckedChange={(checked) =>
                            toggleRow(salesIdentityKey(item), checked === true)
                          }
                          aria-label={`Select ${item.itemName}`}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-md text-foreground">
                            {item.itemName}
                          </span>
                          {item.externalVariantTitle ? (
                            <span className="mt-0.5 block truncate text-xs text-faint">
                              {item.externalVariantTitle}
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-base text-muted-foreground tabular-nums">
                          {item.sku || "—"}
                        </span>
                        <span className="truncate text-base text-muted-foreground">
                          {channelLabel(item.channel)}
                        </span>
                        <span
                          className="truncate text-base text-muted-foreground"
                          title={orderSourceLabel(item.orderSources)}
                        >
                          {orderSourceLabel(item.orderSources) || "—"}
                        </span>
                        <span className="text-right text-base text-muted-foreground tabular-nums">
                          {item.lineCount
                            ? quantityFormat.format(item.quantity)
                            : "—"}
                        </span>
                        <span className="text-right text-base text-muted-foreground tabular-nums">
                          {item.lineCount
                            ? money(item.netSalesCents, item.currencyCode)
                            : "—"}
                        </span>
                        <span className="text-right text-base text-faint tabular-nums">
                          {item.lastSoldAt
                            ? formatFullDate(item.lastSoldAt, timezone)
                            : "—"}
                        </span>
                        <span className="flex justify-end gap-1.5">
                          <Button
                            onClick={() => {
                              setTrackProduct(
                                suggestedProduct(
                                  menuItems,
                                  item.suggestedProductId
                                )
                              )
                              setTrackTarget(item)
                            }}
                          >
                            Track
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() =>
                              setIgnoreTarget({
                                kind: "rows",
                                rows: [item],
                                title: "Ignore this item?",
                                body: `${item.itemName} drops out of Catalog and its sales stop counting toward any product. You can restore it from the Ignored tab.`,
                              })
                            }
                          >
                            Ignore
                          </Button>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {visibleTotal > visibleItems.length ? (
        <p className="mt-3 text-xs text-faint">
          {query
            ? `Showing ${visibleItems.length} of ${visibleTotal} matches.`
            : `Showing the ${visibleItems.length} biggest by net sales. Clear some to see the rest.`}
        </p>
      ) : null}

      {/* One controlled dialog serves every Track button; keying it on the
          target remounts the form with that identity's prefill. */}
      {trackTarget ? (
        <MenuItemDialog
          // Keyed on the identity alone: including the chosen product would
          // remount the dialog mid-edit and discard the kind, name, members
          // and price already typed into it.
          key={salesIdentityKey(trackTarget)}
          product={trackProduct ?? undefined}
          products={menuItems}
          recipes={recipes}
          open
          onOpenChange={(next) => {
            if (!next) {
              setTrackTarget(null)
              setTrackProduct(null)
            }
          }}
          initialName={trackProduct ? undefined : trackTarget.itemName}
          initialVariant={{
            channel: trackTarget.channel,
            providerAccountId: trackTarget.providerAccountId,
            matchKey: trackTarget.matchKey,
            sku: trackTarget.sku,
            externalName: trackTarget.itemName,
            externalVariantTitle: trackTarget.externalVariantTitle,
            externalObjectId: trackTarget.externalObjectId,
            productExternalObjectId: trackTarget.productExternalObjectId,
          }}
          onProductChoice={(productId) =>
            setTrackProduct(
              menuItems.find((item) => item.id === productId) ?? null
            )
          }
          onSaved={() => {
            // The variant now claims this identity; drop it from the queue
            // immediately rather than waiting for the revalidated payload.
            setDismissed(
              (current) => new Set([...current, salesIdentityKey(trackTarget)])
            )
            setTrackTarget(null)
            setTrackProduct(null)
          }}
        />
      ) : null}

      {detailTarget ? (
        <IdentityLinesDialog
          item={detailTarget}
          onOpenChange={(next) => {
            if (!next) setDetailTarget(null)
          }}
        />
      ) : null}

      <ConfirmDialog
        open={ignoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) setIgnoreTarget(null)
        }}
        title={ignoreTarget?.title ?? ""}
        description={ignoreTarget?.body ?? ""}
        confirmLabel="Ignore"
        onConfirm={confirmIgnore}
      />
    </>
  )
}
