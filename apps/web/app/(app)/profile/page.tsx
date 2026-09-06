import type { Metadata } from "next"

import { Page, PageHeader, PageTitle } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"

export const metadata: Metadata = {
  title: "Your profile",
}

export default async function ProfilePage() {
  const user = await requireUser()

  return (
    <Page>
      <PageHeader className="block">
        <PageTitle>Your profile</PageTitle>
        <p className="mt-[5px] text-base text-muted-foreground">
          The account this workspace belongs to.
        </p>
      </PageHeader>

      <dl className="max-w-[640px] overflow-hidden rounded-xl border border-border">
        <div className="border-b border-muted px-4 py-3.5 last:border-b-0">
          <dt className="text-base text-muted-foreground">Name</dt>
          <dd className="mt-[3px] text-md">{user.name}</dd>
        </div>
        <div className="border-b border-muted px-4 py-3.5 last:border-b-0">
          <dt className="text-base text-muted-foreground">Email</dt>
          <dd className="mt-[3px] text-md">{user.email}</dd>
        </div>
      </dl>
    </Page>
  )
}
