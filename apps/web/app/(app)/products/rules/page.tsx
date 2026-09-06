import { redirectWithQuery } from "@/lib/redirect-with-query"

export default async function IgnoreRulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  redirectWithQuery("/integrations/sales/mapping/rules", await searchParams)
}
