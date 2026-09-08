import { ProductsTitle } from "@/components/menu/products-title"
import { Page } from "@/components/ui/page"

/** The Products hub tabs and each product's own page share one screen frame
    and one breadcrumb. */
export default function ProductsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <Page variant="wide">
      <ProductsTitle />
      {children}
    </Page>
  )
}
