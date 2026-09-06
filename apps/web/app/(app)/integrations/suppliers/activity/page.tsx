import type { Metadata } from "next"

import { SupplierActivity } from "@/components/integrations/supplier-activity"
import { requireUser } from "@/lib/auth-session"
import {
  getConnectorSyncRuns,
  getInvoicesOverview,
} from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Activity" }

export default async function SuppliersActivityPage() {
  await requireUser()
  // The provider list only names a run's connector; it travels with the
  // invoice overview, the same snapshot the Connections page reads.
  const [runs, overview] = await Promise.all([
    getConnectorSyncRuns(),
    getInvoicesOverview(),
  ])

  return (
    <SupplierActivity runs={runs} providers={overview.connectors.providers} />
  )
}
