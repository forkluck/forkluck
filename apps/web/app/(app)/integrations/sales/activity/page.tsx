import type { Metadata } from "next"

import { SalesActivity } from "@/components/integrations/sales-activity"
import { requireUser } from "@/lib/auth-session"
import { getPosSyncRuns, getSalesImports } from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Activity" }

export default async function SalesActivityPage() {
  await requireUser()
  const [imports, syncRuns] = await Promise.all([
    getSalesImports(),
    getPosSyncRuns(),
  ])

  return <SalesActivity imports={imports} syncRuns={syncRuns} />
}
