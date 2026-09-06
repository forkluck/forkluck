import Link from "next/link"

import { Button } from "@/components/ui/button"
import { EmptyState, Page, PageHeader, PageTitle } from "@/components/ui/page"

export default function AppNotFound() {
  return (
    <Page>
      <PageHeader>
        <PageTitle>Not found</PageTitle>
      </PageHeader>
      <EmptyState
        title="This page doesn’t exist"
        description="The link may be out of date, or the record was deleted."
      >
        <Button nativeButton={false} render={<Link href="/" />}>
          Back to dashboard
        </Button>
      </EmptyState>
    </Page>
  )
}
