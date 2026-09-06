import {
  ColumnLabel,
  ListBody,
  ListCard,
  ListCardEmpty,
  ListHeader,
  listRowClassName,
} from "@/components/overview/analytics-cards"
import type { Channel } from "@/components/overview/channel-filter"
import type { CurrencyCode } from "@/lib/business-settings"
import type { SalesOverview } from "@/lib/backend/types"
import { formatWholeCents } from "@/lib/money"
import { topProducts } from "@/lib/top-products"
import { cn } from "@/lib/utils"

/** Two digits, not the shared three: this card's Sold column is 92px wide. */
const quantityFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
})

/** Product · Sold · Sales, shared by the header and every row. The numeric
 * columns give a phone back 24px of product name. */
const columns =
  "grid grid-cols-[minmax(0,1fr)_72px_76px] sm:grid-cols-[minmax(0,1fr)_92px_80px]"

export function TopProductsCard({
  productSales,
  channel,
  currencyCode,
}: {
  productSales: SalesOverview["topProducts"]
  channel: Channel
  currencyCode: CurrencyCode
}) {
  const products = topProducts(productSales, channel)
  const hasShared = products.some((product) => product.sharedToMembers)

  return (
    <ListCard title="Top products">
      {products.length ? (
        <>
          <ListHeader className={columns}>
            <ColumnLabel>Product</ColumnLabel>
            <ColumnLabel align="end">Sold</ColumnLabel>
            <ColumnLabel align="end">Sales</ColumnLabel>
          </ListHeader>
          <ListBody>
            {products.map((product) => (
              <div key={product.id} className={cn(columns, listRowClassName)}>
                <span className="truncate text-md leading-5">
                  {product.name}
                </span>
                <span className="text-right text-base text-faint tabular-nums">
                  {quantityFormat.format(product.quantity)}
                </span>
                <span
                  title={
                    product.sharedToMembers
                      ? "Counted on the products inside this bundle"
                      : undefined
                  }
                  className="text-right text-base text-muted-foreground tabular-nums"
                >
                  {product.sharedToMembers
                    ? "Shared"
                    : formatWholeCents(product.netSalesCents, currencyCode)}
                </span>
              </div>
            ))}
          </ListBody>
          {hasShared ? (
            <p className="px-5 pt-2.5 pb-1 text-xs text-muted-foreground">
              Bundle sales are counted on the products inside them.
            </p>
          ) : null}
        </>
      ) : (
        <ListCardEmpty>
          No product sales are recorded in this period.
        </ListCardEmpty>
      )}
    </ListCard>
  )
}
