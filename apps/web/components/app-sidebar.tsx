"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import {
  Book,
  ChartColumn,
  CircleAlert,
  FileText,
  Home,
  Package,
  PanelLeft,
  Plus,
  Settings,
  Store,
  Tag,
  Truck,
  Users,
  Utensils,
} from "lucide-react"

import { AppSearch } from "@/components/app-search"
import { BrandMark } from "@/components/brand-mark"
import { KitchenSwitcher } from "@/components/kitchen-switcher"
import { GuardedLink } from "@/components/navigation-blocker"
import { SidebarAccount } from "@/components/sidebar-account"
import type { SessionUser } from "@/lib/auth-session"
import type { ActiveKitchen } from "@/lib/kitchen"
import { cn } from "@/lib/utils"

// Every sidebar row is the same box: 34px tall, radius 8, 10px of side
// padding, a 9px gap to a 17px glyph. Hover on a resting row is the sidebar
// grey; the active row has no fill and turns brand blue, and hovering it tints
// with the same translucent blue as an active section tab.
const ROW_CLASS =
  "flex h-11 w-full items-center gap-[9px] rounded-lg border border-transparent px-2.5 text-base leading-none font-medium text-sidebar-foreground focus-visible:border-foreground focus-visible:outline-none md:h-9"

const ICON_CLASS = "size-[17px] shrink-0"

const SUB_ROW_CLASS =
  "flex h-9 w-full items-center rounded-lg border border-transparent px-2.5 text-base leading-none font-medium text-sidebar-foreground focus-visible:border-foreground focus-visible:outline-none md:h-[30px]"

type NavChild = {
  href: string
  label: string
}

type NavItem = {
  href: string
  label: string
  icon: typeof Book
  children?: NavChild[]
  action?: { href: string; label: string }
}

/** A labelled run of rows. The first zone carries no label. */
type NavSection = { label?: string; items: NavItem[] }

// Integrations is the only labelled zone; its two families switch between
// their pages with section tabs, not sidebar rows. A row's children show
// only while the family is on screen.
const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { href: "/", label: "Home", icon: Home },
      { href: "/analytics", label: "Analytics", icon: ChartColumn },
      {
        href: "/products",
        label: "Products",
        icon: Tag,
        // Supplies attach to products, never recipes: this is their family.
        children: [{ href: "/supplies", label: "Supplies" }],
      },
      {
        href: "/recipes",
        label: "Recipes",
        icon: Book,
        action: { href: "/recipes/new", label: "New recipe" },
      },
      { href: "/ingredients", label: "Ingredients", icon: Package },
      { href: "/menu", label: "Menus", icon: Utensils },
      { href: "/invoices", label: "Invoices", icon: FileText },
      { href: "/labor", label: "Labor", icon: Users },
    ],
  },
  {
    label: "Integrations",
    items: [
      {
        href: "/integrations/sales",
        label: "Sales",
        icon: Store,
      },
      {
        href: "/integrations/suppliers",
        label: "Suppliers",
        icon: Truck,
      },
    ],
  },
]

const BOTTOM_ITEMS: NavItem[] = [
  { href: "/settings", label: "Settings", icon: Settings },
]

// Everything else in the nav is money, suppliers or account: owner-only by
// decision, not by omission. A member kitchen is a recipe book.
const MEMBER_HREFS = new Set(["/recipes"])

const ISSUE_URL = "https://github.com/forkluck/forkluck/issues"

export function AppSidebar({
  user,
  kitchen = null,
  kitchens = [],
  primoEnabled = true,
  open,
  onOpenChange,
  collapsed = false,
  onCollapse,
}: {
  user: SessionUser
  /** The kitchen being looked at; `null` is the account's own. */
  kitchen?: ActiveKitchen | null
  kitchens?: ActiveKitchen[]
  /** Home is the chat; without Primo there is no Home row to land on. */
  primoEnabled?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Desktop only — the drawer is driven by `open`. */
  collapsed?: boolean
  onCollapse?: () => void
}) {
  const pathname = usePathname()
  const sections = React.useMemo(() => {
    if (!kitchen)
      return primoEnabled
        ? NAV_SECTIONS
        : NAV_SECTIONS.map((section) => ({
            ...section,
            items: section.items.filter((item) => item.href !== "/"),
          }))
    return NAV_SECTIONS.flatMap((section) => {
      const items = section.items.flatMap((item) =>
        MEMBER_HREFS.has(item.href)
          ? // A viewer creates nothing, so the row keeps its link and loses
            // its `+`.
            [kitchen.role === "editor" ? item : { ...item, action: undefined }]
          : []
      )
      return items.length ? [{ ...section, items }] : []
    })
  }, [kitchen, primoEnabled])
  const sidebarRef = React.useRef<HTMLElement>(null)
  const returnFocusRef = React.useRef<HTMLElement | null>(null)
  const [isDesktop, setIsDesktop] = React.useState(false)

  React.useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)")
    const sync = () => setIsDesktop(query.matches)
    sync()
    query.addEventListener("change", sync)
    return () => query.removeEventListener("change", sync)
  }, [])

  React.useEffect(() => {
    if (!open || isDesktop) return

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null

    const sidebar = sidebarRef.current
    const getFocusable = () =>
      sidebar
        ? Array.from(
            sidebar.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          )
        : []

    const frame = window.requestAnimationFrame(() => getFocusable()[0]?.focus())
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onOpenChange(false)
        return
      }
      if (event.key !== "Tab") return

      const focusable = getFocusable()
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = previousOverflow
      returnFocusRef.current?.focus()
    }
  }, [isDesktop, open, onOpenChange])

  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`)

  const navRow = (item: NavItem) => {
    const childActive = item.children?.some((child) => isActive(child.href))
    // A child living off the parent's path (Supplies) still opens the family.
    const active = isActive(item.href) || Boolean(childActive)
    const filled = active && !childActive

    return (
      <React.Fragment key={item.href}>
        <div
          className={cn(
            "relative rounded-lg",
            filled ? "hover:bg-brand/10" : "hover:bg-sidebar-hover",
            item.action && "has-[[data-nav-action]:hover]:bg-transparent"
          )}
        >
          <GuardedLink
            href={item.href}
            onClick={() => onOpenChange(false)}
            aria-current={filled ? "page" : undefined}
            className={cn(
              ROW_CLASS,
              item.action && "pr-9",
              filled && "font-semibold text-brand"
            )}
          >
            <item.icon
              className={ICON_CLASS}
              strokeWidth={2}
              aria-hidden="true"
            />
            {item.label}
          </GuardedLink>

          {item.action ? (
            <GuardedLink
              href={item.action.href}
              data-nav-action=""
              onClick={() => onOpenChange(false)}
              aria-label={item.action.label}
              title={item.action.label}
              className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md border border-transparent text-faint hover:bg-sidebar-hover hover:text-sidebar-foreground focus-visible:border-foreground focus-visible:outline-none md:size-6"
            >
              <Plus className="size-4" strokeWidth={1.8} aria-hidden="true" />
            </GuardedLink>
          ) : null}
        </div>

        {item.children && active ? (
          <div className="ml-[18px] flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
            {item.children.map((child) => {
              const active = isActive(child.href)

              return (
                <GuardedLink
                  key={child.href}
                  href={child.href}
                  onClick={() => onOpenChange(false)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    SUB_ROW_CLASS,
                    active
                      ? "font-semibold text-brand hover:bg-brand/10"
                      : "hover:bg-sidebar-hover"
                  )}
                >
                  {child.label}
                </GuardedLink>
              )
            })}
          </div>
        ) : null}
      </React.Fragment>
    )
  }

  return (
    <>
      <div
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
        className={cn(
          // Same scrim as the modals.
          "fixed inset-0 z-40 bg-[rgba(24,24,27,0.28)] transition-opacity duration-200 motion-reduce:transition-none md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />

      <aside
        ref={sidebarRef}
        id="app-sidebar"
        role={!isDesktop ? "dialog" : undefined}
        aria-label={!isDesktop ? "Navigation" : undefined}
        aria-modal={!isDesktop && open ? true : undefined}
        aria-hidden={!isDesktop && !open ? true : undefined}
        inert={!isDesktop && !open ? true : undefined}
        className={cn(
          // A drawer below md, a plain grid column above it. On desktop the
          // content edge is a hairline in --muted, a step softer than the
          // hairline everything else uses, so the sidebar reads as one fill
          // with an edge rather than a bordered panel.
          "fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col bg-sidebar px-4 pb-5 text-sidebar-foreground transition-transform duration-200 motion-reduce:transition-none md:static md:z-auto md:h-full md:w-auto md:translate-x-0 md:border-r md:border-muted print:hidden",
          open ? "translate-x-0" : "-translate-x-full",
          collapsed && "md:hidden"
        )}
      >
        {/* Logo row: mark on the left, search and collapse on the right. The
            fixed height mirrors the main header bar so the controls here sit
            on the same centerline as the hamburger they replace. */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-1.5 md:h-[58px]">
          <BrandMark className="min-w-0" />
          <div className="flex shrink-0 items-center gap-0.5">
            <AppSearch />
            <button
              type="button"
              // Closes the drawer on mobile, hides the whole column on
              // desktop — the header grows a matching control to bring it
              // back, and only while it is gone.
              onClick={() => {
                onOpenChange(false)
                onCollapse?.()
              }}
              aria-label="Collapse sidebar"
              aria-controls="app-sidebar"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-transparent text-sidebar-foreground hover:bg-sidebar-hover focus-visible:border-foreground focus-visible:outline-none md:size-8"
            >
              <PanelLeft
                className={ICON_CLASS}
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        {/* Primary rows, then Settings and Submit an issue at the foot. */}
        <nav
          aria-label="Main"
          className="mt-2.5 flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {sections.map((section, index) => (
            <div
              key={section.label ?? "top"}
              className={cn("flex flex-col gap-0.5", index > 0 && "mt-6")}
              role={section.label ? "group" : undefined}
              aria-labelledby={section.label ? `nav-zone-${index}` : undefined}
            >
              {section.label ? (
                <div
                  id={`nav-zone-${index}`}
                  className="px-2.5 pb-1 text-xs leading-none font-medium text-faint"
                >
                  {section.label}
                </div>
              ) : null}
              {section.items.map(navRow)}
            </div>
          ))}

          <div className="mt-auto flex flex-col gap-0.5 pt-[18px]">
            {/* Settings is the owner's account; a member has none here. */}
            {kitchen ? null : BOTTOM_ITEMS.map(navRow)}
            <a
              href={ISSUE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(ROW_CLASS, "hover:bg-sidebar-hover")}
            >
              <CircleAlert
                className={ICON_CLASS}
                strokeWidth={2}
                aria-hidden="true"
              />
              Submit an issue
            </a>
          </div>
        </nav>

        {/* No divider above the user row — 12px of space is the whole break. */}
        <div className="mt-3 flex shrink-0 flex-col gap-0.5">
          {kitchens.length > 0 ? (
            <div className="flex items-center">
              <KitchenSwitcher
                kitchens={kitchens}
                active={kitchen}
                onNavigate={() => onOpenChange(false)}
              />
            </div>
          ) : null}
          <div className="flex items-center">
            <SidebarAccount
              user={user}
              onNavigate={() => onOpenChange(false)}
            />
          </div>
        </div>
      </aside>
    </>
  )
}
