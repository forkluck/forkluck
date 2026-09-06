import type { Metadata } from "next"

import {
  SupplierItemsTable,
  SupplierMappingTabs,
} from "@/components/integrations/supplier-items-table"
import { SuppliersList } from "@/components/settings/suppliers-list"
import { requireUser } from "@/lib/auth-session"
import { allowedSearchParam, singleSearchParam } from "@/lib/backend/pagination"
import {
  getIngredientOptions,
  getInvoiceSuppliers,
  getSupplierItems,
} from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Mapping" }

const PAGE_SIZE = 50

function offsetParam(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0
  const offset = Number(value)
  return Number.isSafeInteger(offset) ? offset - (offset % PAGE_SIZE) : 0
}

export default async function SuppliersMappingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireUser()
  const params = await searchParams
  const tab = allowedSearchParam(
    singleSearchParam(params.tab),
    ["items", "suppliers"],
    "items"
  )
  if (tab === "suppliers") {
    return (
      <>
        <SupplierMappingTabs tab={tab} />
        <SuppliersList />
      </>
    )
  }

  const view = allowedSearchParam(
    singleSearchParam(params.view),
    ["all", "ignored"],
    "all"
  )
  const query = (singleSearchParam(params.q) ?? "").trim().slice(0, 120)
  const supplier = (singleSearchParam(params.supplier) ?? "")
    .trim()
    .slice(0, 64)
  const offset = offsetParam(singleSearchParam(params.offset))
  const [page, suppliers, ingredients] = await Promise.all([
    getSupplierItems({
      supplier,
      q: query,
      tab: view === "ignored" ? "ignored" : "items",
      limit: PAGE_SIZE,
      offset,
    }),
    getInvoiceSuppliers(),
    getIngredientOptions(),
  ])

  return (
    <>
      <SupplierMappingTabs tab={tab} />
      <SupplierItemsTable
        rows={page.items}
        total={page.total}
        offset={offset}
        limit={PAGE_SIZE}
        view={view}
        supplier={supplier}
        query={query}
        suppliers={suppliers}
        ingredients={ingredients}
      />
    </>
  )
}
