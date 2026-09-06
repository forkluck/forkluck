import { Page } from "@/components/ui/page"
import { Spinner } from "@/components/ui/spinner"

/**
 * Shown instantly on in-app navigation while the next page renders. The shell
 * stays interactive around one large activity mark centered in the remaining
 * viewport.
 */
export default function Loading() {
  return (
    <Page className="py-0" aria-busy="true">
      <div className="grid min-h-[calc(100dvh-58px)] place-items-center">
        <Spinner size="lg" delayed label="Loading page" />
      </div>
    </Page>
  )
}
