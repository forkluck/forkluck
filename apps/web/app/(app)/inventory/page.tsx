import type { Metadata } from "next"

import { EmptyState, Page, PageHeader, PageTitle } from "@/components/ui/page"

export const metadata: Metadata = {
  title: "Inventory",
}

export default function InventoryPage() {
  return (
    <Page>
      <PageHeader>
        <PageTitle>Inventory</PageTitle>
      </PageHeader>

      <EmptyState
        title="Under construction"
        description="Inventory is being built. It will track what you have on hand, draw down against the recipes you produce, and value the count with the prices your invoices already carry."
      />
    </Page>
  )
}
