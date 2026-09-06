import type { Metadata } from "next"

import { SalesMappingTabs } from "@/components/integrations/sales-mapping-tabs"
import { IgnoredTable } from "@/components/menu/ignored-table"
import { requireUser } from "@/lib/auth-session"
import { getMenuOverview } from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Ignored" }

export default async function SalesMappingIgnoredPage() {
  await requireUser()
  const overview = await getMenuOverview(["ignored"])
  const {
    ignoredItems,
    ignoredModifiers,
    ignoredItemCount,
    ignoredModifierCount,
  } = overview.review

  return (
    <>
      <SalesMappingTabs />
      <IgnoredTable
        items={ignoredItems}
        modifiers={ignoredModifiers}
        itemCount={ignoredItemCount}
        modifierCount={ignoredModifierCount}
      />
    </>
  )
}
