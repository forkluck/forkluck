import Link from "next/link"

import { PrimoHomeChat } from "@/components/primo/primo-home-chat"
import { TabPill, TabPills } from "@/components/ui/tab-pills"

export function HomeTabs({
  tab,
  primoEnabled,
  topProductName,
  userName,
  children,
}: {
  tab: string | string[] | undefined
  primoEnabled: boolean
  topProductName: string
  userName: string
  children: React.ReactNode
}) {
  if (!primoEnabled) return children
  const active = tab === "activity" ? "activity" : "chat"
  const tabs = (
    <TabPills className="w-fit">
      <TabPill active={active === "chat"} render={<Link href="/" />}>
        Chat
      </TabPill>
      <TabPill
        active={active === "activity"}
        render={<Link href="?tab=activity" />}
      >
        Activity
      </TabPill>
    </TabPills>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {active === "chat" ? (
        <PrimoHomeChat
          tabs={tabs}
          topProductName={topProductName}
          userName={userName}
        />
      ) : (
        <>
          <div className="mx-auto mb-4 flex w-full max-w-[1000px] px-4 lg:justify-center">
            {tabs}
          </div>
          {children}
        </>
      )}
    </div>
  )
}
