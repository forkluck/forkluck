"use client"

import { usePathname } from "next/navigation"

import {
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
} from "@/components/ui/page"
import { SectionTab, SectionTabs } from "@/components/ui/section-tabs"

/** An integration family: its screen, and the pages it switches between. */
const FAMILIES = {
  sales: {
    href: "/integrations/sales",
    label: "Sales",
    tabs: [
      { href: "/integrations/sales/connections", label: "Connections" },
      { href: "/integrations/sales/mapping", label: "Mapping" },
      { href: "/integrations/sales/activity", label: "Activity" },
    ],
  },
  suppliers: {
    href: "/integrations/suppliers",
    label: "Suppliers",
    tabs: [
      { href: "/integrations/suppliers/connections", label: "Connections" },
      { href: "/integrations/suppliers/mapping", label: "Mapping" },
      { href: "/integrations/suppliers/activity", label: "Activity" },
    ],
  },
}

/**
 * The Integrations title: the section on the line above, the family in ink,
 * and the family's pages as section tabs beneath — the same row Invoices and
 * an ingredient use, so the sidebar can stop at the family.
 */
export function IntegrationsTitle() {
  const pathname = usePathname()
  const family = pathname.startsWith(FAMILIES.suppliers.href)
    ? FAMILIES.suppliers
    : FAMILIES.sales

  return (
    <>
      <PageHeader className="block">
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            <PageParent href="/integrations">Integrations</PageParent>
          </PageParents>
          <PageTitle>
            <span className="truncate">{family.label}</span>
          </PageTitle>
        </div>
      </PageHeader>
      <SectionTabs>
        {family.tabs.map((tab) => (
          <SectionTab
            key={tab.href}
            href={tab.href}
            // Mapping's own tables (Catalog, Modifiers…) live under its path.
            active={
              pathname === tab.href || pathname.startsWith(`${tab.href}/`)
            }
          >
            {tab.label}
          </SectionTab>
        ))}
      </SectionTabs>
    </>
  )
}
