import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { PrimoHomeChat } from "@/components/primo/primo-home-chat"
import { getSession, requireUser } from "@/lib/auth-session"
import { primoAvailable } from "@/lib/primo/access"

export const metadata: Metadata = {
  title: "Home",
}

/**
 * Home is the chat. It reads nothing but the session, so it is on screen the
 * moment the shell is. An account without Primo has no chat to land on, and
 * its sidebar has no Home row: it lives on Analytics instead.
 */
export default async function HomePage() {
  const user = await requireUser()
  const session = await getSession()
  if (!session || !primoAvailable(session.billing)) redirect("/analytics")
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PrimoHomeChat userName={user.name} />
    </div>
  )
}
