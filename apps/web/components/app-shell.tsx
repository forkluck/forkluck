"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { MainHeader } from "@/components/main-header"
import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"
import { KitchenToolsWebMcp } from "@/components/primo/kitchen-tools-webmcp"
import { PrimoProvider, usePrimo } from "@/components/primo/primo-provider"
import { PrimoRail } from "@/components/primo/primo-rail"
import { ReadOnlyBanner } from "@/components/billing/read-only-banner"
import { LoadingRegion } from "@/components/ui/loading-region"
import { ToastProvider } from "@/components/ui/toast"
import type { SessionUser } from "@/lib/auth-session"
import type { ActiveKitchen } from "@/lib/kitchen"
import type { KitchenToolDescriptor } from "@/lib/primo/kitchen-tools"
import { useVisualViewport } from "@/hooks/use-visual-viewport"
import { cn } from "@/lib/utils"

function AppShellContents({
  user,
  kitchen,
  kitchens,
  children,
  primoEnabled,
  webmcpTools,
  readOnlyNotice,
}: {
  user: SessionUser
  kitchen: ActiveKitchen | null
  kitchens: ActiveKitchen[]
  children: React.ReactNode
  primoEnabled: boolean
  webmcpTools: KitchenToolDescriptor[]
  readOnlyNotice: string | null
}) {
  const [navOpen, setNavOpen] = React.useState(false)
  const [collapsed, setCollapsed] = React.useState(false)
  const primoTriggerRef = React.useRef<HTMLButtonElement>(null)
  const { open: primoOpen, setOpen: setPrimoOpen, inlineCount = 0 } = usePrimo()
  const pathname = usePathname()
  // Home mounts its own conversation, which the header trigger and the rail
  // give way to. The route says so before the page has rendered, so the
  // trigger does not flash in over the loading screen and vanish once the
  // chat registers itself.
  const homeChat = primoEnabled && pathname === "/"
  const inlineChat = inlineCount > 0 || homeChat
  const viewport = useVisualViewport(inlineCount > 0)
  const primoRailVisible = primoOpen && !inlineChat
  // A navigation keeps the page you were on. Past 200 ms it dims behind one
  // mark; a warm route lands inside that and shows nothing at all, which
  // reads as faster than a page that blinked to a spinner and back.
  const { navigationPending } = useNavigationBlocker()
  const [passedThreshold, setPassedThreshold] = React.useState(false)
  // Reset in render, the moment the wait ends, so the next one starts its
  // 200 ms from zero.
  if (!navigationPending && passedThreshold) setPassedThreshold(false)
  React.useEffect(() => {
    if (!navigationPending) return
    const timer = window.setTimeout(() => setPassedThreshold(true), 200)
    return () => window.clearTimeout(timer)
  }, [navigationPending])
  const slow = navigationPending && passedThreshold

  function setPrimoVisibility(open: boolean) {
    setPrimoOpen(open)
    if (!open) {
      window.requestAnimationFrame(() => primoTriggerRef.current?.focus())
    }
  }

  return (
    <>
      <KitchenToolsWebMcp tools={webmcpTools} />
      <div data-app-shell="" className="flex min-h-svh bg-background">
        <div
          style={viewport ? { height: viewport.height } : undefined}
          className={cn(
            "flex h-svh w-full min-w-0 flex-col bg-background md:grid md:overflow-hidden print:block print:h-auto print:overflow-visible",
            collapsed ? "md:grid-cols-[1fr]" : "md:grid-cols-[248px_1fr]",
            collapsed && primoRailVisible
              ? "lg:grid-cols-[1fr_360px]"
              : collapsed
                ? "lg:grid-cols-[1fr]"
                : primoRailVisible
                  ? "lg:grid-cols-[248px_1fr_360px]"
                  : "lg:grid-cols-[248px_1fr]"
          )}
        >
          <AppSidebar
            user={user}
            kitchen={kitchen}
            kitchens={kitchens}
            primoEnabled={primoEnabled}
            open={navOpen}
            onOpenChange={setNavOpen}
            collapsed={collapsed}
            onCollapse={() => setCollapsed(true)}
          />
          <div
            data-content=""
            className={cn(
              "flex min-w-0 flex-1 flex-col bg-background md:h-full md:overflow-y-auto print:block print:h-auto print:overflow-visible",
              inlineCount > 0 && "min-h-0 overflow-hidden"
            )}
          >
            <MainHeader
              navOpen={navOpen}
              onOpenNav={() => setNavOpen(true)}
              sidebarCollapsed={collapsed}
              onExpandSidebar={() => setCollapsed(false)}
              primoEnabled={primoEnabled && !inlineChat}
              primoOpen={primoOpen}
              onTogglePrimo={() => setPrimoVisibility(!primoOpen)}
              primoTriggerRef={primoTriggerRef}
            />
            {readOnlyNotice ? (
              <div className="px-4 pt-4 sm:px-6 print:hidden">
                <ReadOnlyBanner notice={readOnlyNotice} />
              </div>
            ) : null}
            <LoadingRegion
              pending={slow}
              label="Loading page"
              className="flex-1"
            >
              {children}
            </LoadingRegion>
          </div>
          {primoEnabled && !homeChat ? (
            <PrimoRail
              userName={user.name}
              onClose={() => setPrimoVisibility(false)}
            />
          ) : null}
        </div>
      </div>
    </>
  )
}

export function AppShell({
  user,
  kitchen = null,
  kitchens = [],
  children,
  primoEnabled = false,
  webmcpTools = [],
  readOnlyNotice = null,
}: {
  user: SessionUser
  kitchen?: ActiveKitchen | null
  kitchens?: ActiveKitchen[]
  children: React.ReactNode
  primoEnabled?: boolean
  webmcpTools?: KitchenToolDescriptor[]
  readOnlyNotice?: string | null
}) {
  return (
    <NavigationBlockerProvider>
      <ToastProvider>
        <PrimoProvider key={user.id} userId={user.id}>
          <AppShellContents
            user={user}
            kitchen={kitchen}
            kitchens={kitchens}
            primoEnabled={primoEnabled}
            webmcpTools={webmcpTools}
            readOnlyNotice={readOnlyNotice}
          >
            {children}
          </AppShellContents>
        </PrimoProvider>
      </ToastProvider>
    </NavigationBlockerProvider>
  )
}
