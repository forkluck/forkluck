import { Spinner } from "@/components/ui/spinner"

/**
 * Shown instantly when moving between the Products hub tabs and a product
 * page. The shared products layout keeps the frame and breadcrumb mounted, so
 * this renders bare — no <Page> wrapper — centered in the space the page's
 * own content will fill.
 */
export default function Loading() {
  return (
    <div className="grid min-h-[50dvh] place-items-center" aria-busy="true">
      <Spinner size="lg" delayed label="Loading page" />
    </div>
  )
}
