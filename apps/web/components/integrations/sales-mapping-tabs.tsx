"use client"

import { usePathname } from "next/navigation"

import { GuardedLink } from "@/components/navigation-blocker"
import { TabPill, TabPills } from "@/components/ui/tab-pills"

/** The four mapping tables, in the order a merchant works through them. */
const TABS = [
  { href: "/integrations/sales/mapping", label: "Catalog" },
  { href: "/integrations/sales/mapping/modifiers", label: "Modifiers" },
  { href: "/integrations/sales/mapping/ignored", label: "Ignored" },
  { href: "/integrations/sales/mapping/rules", label: "Rules" },
]

/** The strip above every sales mapping table; the sidebar stops at Mapping. */
export function SalesMappingTabs() {
  const pathname = usePathname()

  return (
    <TabPills className="mb-4 w-fit">
      {TABS.map(({ href, label }) => (
        <TabPill
          key={href}
          active={pathname === href}
          render={<GuardedLink href={href} />}
        >
          {label}
        </TabPill>
      ))}
    </TabPills>
  )
}
