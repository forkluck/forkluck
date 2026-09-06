import type { Metadata } from "next"
import { ExternalLink } from "lucide-react"

import { Page, PageHeader, PageTitle } from "@/components/ui/page"
import { MARKETING_ORIGIN } from "@/lib/public-site"

export const metadata: Metadata = {
  title: "Source & legal",
}

const externalLinkClassName =
  "inline-flex items-center gap-1.5 rounded-sm font-medium text-foreground underline decoration-border underline-offset-4 outline-none hover:decoration-foreground focus-visible:decoration-foreground"

export default function SourceAndLegalPage() {
  return (
    <Page>
      <div className="max-w-[720px]">
        <PageHeader className="block">
          <PageTitle>Source &amp; legal</PageTitle>
          <p className="mt-[5px] text-base text-muted-foreground">
            Forkluck&apos;s source license and service policies.
          </p>
        </PageHeader>

        <section
          aria-labelledby="open-source-heading"
          className="mt-8 border-t border-border pt-6"
        >
          <h2 id="open-source-heading" className="font-semibold">
            Open-source software
          </h2>
          <div className="mt-3 space-y-3 text-md leading-6 text-muted-foreground">
            <p>
              Forkluck is open-source software licensed under the GNU Affero
              General Public License version 3 or any later version. The license
              includes the complete terms for using, sharing, and modifying the
              source.
            </p>
            <p>
              <a
                href="https://github.com/forkluck/forkluck"
                className={externalLinkClassName}
              >
                View Forkluck source code
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </p>
          </div>
        </section>

        <section
          aria-labelledby="service-policies-heading"
          className="mt-8 border-t border-border pt-6"
        >
          <h2 id="service-policies-heading" className="font-semibold">
            Service policies
          </h2>
          <p className="mt-3 text-md leading-6 text-muted-foreground">
            The policies that apply to your Forkluck account and the information
            you add to the service.
          </p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-3 text-md leading-5">
            <a
              href={`${MARKETING_ORIGIN}/terms`}
              className={externalLinkClassName}
            >
              Terms of Service
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
            <a
              href={`${MARKETING_ORIGIN}/privacy`}
              className={externalLinkClassName}
            >
              Privacy Policy
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </div>
        </section>

        <p className="mt-8 border-t border-border pt-6 text-xs leading-5 text-muted-foreground">
          Questions about Forkluck? Email{" "}
          <a href="mailto:guero@forkluck.com" className={externalLinkClassName}>
            guero@forkluck.com
          </a>
          .
        </p>
      </div>
    </Page>
  )
}
