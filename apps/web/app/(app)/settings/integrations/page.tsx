import { redirectWithQuery } from "@/lib/redirect-with-query"

export default async function SettingsIntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  redirectWithQuery("/integrations/suppliers/connections", await searchParams)
}
