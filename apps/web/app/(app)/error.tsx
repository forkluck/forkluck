"use client"

import { Button } from "@/components/ui/button"
import { EmptyState, Page, PageHeader, PageTitle } from "@/components/ui/page"

/**
 * Next renders this inside `(app)/layout.tsx`, so a failed Django read costs
 * the page body and not the sidebar, the header, or the merchant's place.
 */
export default function AppError({ reset }: { reset: () => void }) {
  return (
    <Page>
      <PageHeader>
        <PageTitle>Something went wrong</PageTitle>
      </PageHeader>
      <EmptyState
        title="This page didn’t load"
        description="Something went wrong on our side. Nothing was lost — try again."
      >
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      </EmptyState>
    </Page>
  )
}
