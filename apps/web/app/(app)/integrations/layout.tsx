import { IntegrationsTitle } from "@/components/integrations/integrations-title"
import { Page } from "@/components/ui/page"

/** Every Integrations page shares one screen frame and one breadcrumb. */
export default function IntegrationsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <Page>
      <IntegrationsTitle />
      {children}
    </Page>
  )
}
