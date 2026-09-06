import { redirectWithQuery } from "@/lib/redirect-with-query"

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  redirectWithQuery("/integrations/sales/connections", await searchParams)
}
