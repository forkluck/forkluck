import { RouteLoading } from "@/components/ui/route-loading"

/**
 * Shown instantly on in-app navigation while the next page renders. The shell
 * stays interactive around one large activity mark centered in the remaining
 * viewport; the Primo trigger waits with the page.
 */
export default function Loading() {
  return <RouteLoading />
}
