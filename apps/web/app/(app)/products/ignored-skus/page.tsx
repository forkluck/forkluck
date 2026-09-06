import { redirectWithQuery } from "@/lib/redirect-with-query"

export default async function IgnoredSkusPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  redirectWithQuery("/integrations/sales/mapping/ignored", await searchParams)
}
