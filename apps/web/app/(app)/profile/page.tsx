import type { Metadata } from "next"

import { DeleteAccount } from "@/components/profile/delete-account"
import { DevicesList } from "@/components/profile/devices-list"
import { Page, PageHeader, PageTitle } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { getDevices } from "@/lib/backend/queries"

export const metadata: Metadata = {
  title: "Your profile",
}

export default async function ProfilePage() {
  const user = await requireUser()
  const devices = await getDevices()

  return (
    <Page>
      <PageHeader className="block">
        <PageTitle>Your profile</PageTitle>
        <p className="mt-[5px] text-md text-muted-foreground">
          The account this workspace belongs to.
        </p>
      </PageHeader>

      <dl className="max-w-[640px] overflow-hidden rounded-xl border border-border">
        <div className="border-b border-muted px-4 py-3.5 last:border-b-0">
          <dt className="text-md text-muted-foreground">Name</dt>
          <dd className="mt-[3px] text-md">{user.name}</dd>
        </div>
        <div className="border-b border-muted px-4 py-3.5 last:border-b-0">
          <dt className="text-md text-muted-foreground">Email</dt>
          <dd className="mt-[3px] text-md">{user.email}</dd>
        </div>
      </dl>

      <section className="mt-8">
        <h2 className="text-md font-medium">Signed-in phones</h2>
        <p className="mt-[3px] mb-3 text-md text-muted-foreground">
          Phones using the Forkluck Recipes app with this account.
        </p>
        <DevicesList devices={devices} />
      </section>

      <section className="mt-8">
        <h2 className="text-md font-medium">Delete account</h2>
        <p className="mt-[3px] mb-3 text-md text-muted-foreground">
          Deletes your account, every recipe and record in it, and signs out
          every phone. This cannot be undone.
        </p>
        <DeleteAccount />
      </section>
    </Page>
  )
}
