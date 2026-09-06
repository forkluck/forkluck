import { redirectWithQuery } from "@/lib/redirect-with-query"

export default async function MenuModifiersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  redirectWithQuery("/integrations/sales/mapping/modifiers", await searchParams)
}
