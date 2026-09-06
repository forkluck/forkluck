"use client"

import { usePathname } from "next/navigation"

import { PageHeader, PageTitle } from "@/components/ui/page"

/** One segment under /products is a product's own page. */
const PRODUCT_DETAIL_PATH = /^\/products\/[^/]+$/i

/** The Products title. The hub is one screen, so it carries no breadcrumb. */
export function ProductsTitle() {
  const pathname = usePathname()
  // Detail pages render their mutable Product chrome at page level. Leaving
  // the hub title mounted here would create a second breadcrumb above it.
  if (PRODUCT_DETAIL_PATH.test(pathname)) return null

  return (
    <PageHeader className="block">
      <PageTitle>
        <span className="truncate">Products</span>
      </PageTitle>
    </PageHeader>
  )
}
