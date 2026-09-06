import { ProductsTitle } from "@/components/menu/products-title"
import { Page } from "@/components/ui/page"
import {
  SegmentChrome,
  SegmentLoadingProvider,
} from "@/components/ui/route-loading"

/** The Products hub tabs and each product's own page share one screen frame
    and one breadcrumb. */
export default function ProductsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <SegmentLoadingProvider>
      <Page variant="wide">
        <SegmentChrome>
          <ProductsTitle />
        </SegmentChrome>
        {children}
      </Page>
    </SegmentLoadingProvider>
  )
}
