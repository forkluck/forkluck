"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { MainHeader } from "@/components/main-header"
import { NavigationBlockerProvider } from "@/components/navigation-blocker"
import { KitchenToolsWebMcp } from "@/components/primo/kitchen-tools-webmcp"
import { PrimoProvider, usePrimo } from "@/components/primo/primo-provider"
import { PrimoRail } from "@/components/primo/primo-rail"
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
}: {
  user: SessionUser
  kitchen: ActiveKitchen | null
  kitchens: ActiveKitchen[]
  children: React.ReactNode
  primoEnabled: boolean
  webmcpTools: KitchenToolDescriptor[]
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
            {children}
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
}: {
  user: SessionUser
  kitchen?: ActiveKitchen | null
  kitchens?: ActiveKitchen[]
  children: React.ReactNode
  primoEnabled?: boolean
  webmcpTools?: KitchenToolDescriptor[]
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
          >
            {children}
          </AppShellContents>
        </PrimoProvider>
      </ToastProvider>
    </NavigationBlockerProvider>
  )
}
