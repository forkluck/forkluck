import { redirectWithQuery } from "@/lib/redirect-with-query"

/**
 * The section opens on the Sales family's Connections child; old OAuth returns
 * still name this path, so the query rides along.
 */
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  redirectWithQuery("/integrations/sales/connections", await searchParams)
}
