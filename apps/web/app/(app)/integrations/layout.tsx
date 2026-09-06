import { IntegrationsTitle } from "@/components/integrations/integrations-title"
import { Page } from "@/components/ui/page"
import {
  SegmentChrome,
  SegmentLoadingProvider,
} from "@/components/ui/route-loading"

/** Every Integrations page shares one screen frame and one breadcrumb. */
export default function IntegrationsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <SegmentLoadingProvider>
      <Page>
        <SegmentChrome>
          <IntegrationsTitle />
        </SegmentChrome>
        {children}
      </Page>
    </SegmentLoadingProvider>
  )
}
