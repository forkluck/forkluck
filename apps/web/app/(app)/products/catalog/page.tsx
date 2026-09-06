import { redirectWithQuery } from "@/lib/redirect-with-query"

// The mapping tables moved under Integrations. These folders stay behind as
// redirects because deleting them lets /products/[productId] take the path
// and look the tab name up as a product.
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  redirectWithQuery("/integrations/sales/mapping", await searchParams)
}
