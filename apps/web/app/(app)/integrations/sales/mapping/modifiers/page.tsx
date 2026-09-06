import type { Metadata } from "next"

import { SalesMappingTabs } from "@/components/integrations/sales-mapping-tabs"
import { ModifiersTable } from "@/components/menu/modifiers-table"
import { requireUser } from "@/lib/auth-session"
import { getMenuOverview } from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Modifiers" }

export default async function SalesMappingModifiersPage() {
  await requireUser()
  // `items` backs the product picker when mapping a modifier; no sales shown.
  const overview = await getMenuOverview(["modifiers", "items"])

  return (
    <>
      <SalesMappingTabs />
      <ModifiersTable
        lists={overview.modifierCatalog.lists}
        unassignedRecords={overview.modifierCatalog.unassignedRecords}
        products={overview.items}
        squareConnected={overview.modifierCatalog.squareConnected}
        squareNeedsReconnect={overview.modifierCatalog.squareNeedsReconnect}
        squareSyncedAt={overview.modifierCatalog.squareSyncedAt}
        squareSalesSyncedAt={overview.modifierCatalog.squareSalesSyncedAt}
      />
    </>
  )
}
