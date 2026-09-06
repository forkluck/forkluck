import type { Metadata } from "next"

import { SalesMappingTabs } from "@/components/integrations/sales-mapping-tabs"
import { IgnoreRulesTable } from "@/components/menu/ignore-rules-table"
import { requireUser } from "@/lib/auth-session"
import { getMenuOverview } from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Rules" }

export default async function SalesMappingRulesPage() {
  await requireUser()
  const overview = await getMenuOverview(["rules"])

  return (
    <>
      <SalesMappingTabs />
      <IgnoreRulesTable rules={overview.rules} />
    </>
  )
}
