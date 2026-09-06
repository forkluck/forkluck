import { LinkChannels } from "@/components/settings/link-channels"
import { ProductMatchingRow } from "@/components/settings/product-matching-row"
import { requireUser } from "@/lib/auth-session"
import {
  getBusinessSettings,
  getPosConnections,
  getPosSyncRuns,
} from "@/lib/backend/queries"

/** The Sales family owns channel setup as its Connections child. */
export default async function SalesConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireUser()
  const [connections, syncRuns, businessSettings, params] = await Promise.all([
    getPosConnections(),
    getPosSyncRuns(),
    getBusinessSettings(),
    searchParams,
  ])
  const single = (value: string | string[] | undefined) =>
    typeof value === "string" ? value : undefined

  return (
    <>
      <LinkChannels
        connections={connections}
        syncRuns={syncRuns}
        squareSandboxEnabled={process.env.NODE_ENV !== "production"}
        connected={single(params.connected)}
        integrationError={single(params.integration_error)}
        errorProvider={single(params.provider)}
      />
      <ProductMatchingRow initial={businessSettings.productMatching} />
    </>
  )
}
