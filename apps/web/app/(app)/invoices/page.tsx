import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { InvoicesScreen } from "@/components/invoices/invoices-screen"
import { getSession } from "@/lib/auth-session"
import { getDriveFolder, getInvoicesOverview } from "@/lib/backend/queries"
import { onTrial } from "@/lib/billing"
import { monthSearchParam } from "@/lib/date-search-param"
import { extractionConfig } from "@/lib/invoice-extract"
import type { GoogleDriveConfig } from "@/lib/google-drive"

export const metadata: Metadata = {
  title: "Invoices",
}

/**
 * All three Google values are public by design (origin/referrer restrictions
 * are the protection) and read at runtime from /etc/forkluck/frontend.env —
 * no rebuild to rotate them. Missing values simply hide the Drive button.
 */
function googleDriveConfig(): GoogleDriveConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const apiKey = process.env.GOOGLE_PICKER_API_KEY
  const appId = process.env.GOOGLE_CLOUD_PROJECT_NUMBER
  if (!clientId || !apiKey || !appId) return null
  return { clientId, apiKey, appId }
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // The session read runs beside the data reads, not ahead of them; see
  // ingredients.
  const sessionRead = getSession()
  const { month, q, tab } = await searchParams
  const query = typeof q === "string" ? q : undefined
  const attention = tab === "attention" ? "attention" : undefined
  const reads = Promise.all([
    getInvoicesOverview({
      month: monthSearchParam(month),
      q: query,
      tab: attention,
    }),
    getDriveFolder(),
  ])
  reads.catch(() => undefined)
  const session = await sessionRead
  if (!session) redirect("/login")
  const [overview, drive] = await reads

  return (
    <InvoicesScreen
      overview={overview}
      query={query ?? ""}
      // A search answers across every month, so it is neither tab's list.
      tab={query?.trim() ? null : (attention ?? null)}
      byok={extractionConfig().engine === "anthropic"}
      trial={onTrial(session.billing)}
      driveConfig={googleDriveConfig()}
      driveConnectHref={
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !drive.folder
          ? "/integrations/suppliers/connections"
          : null
      }
    />
  )
}
