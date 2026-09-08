"use client"

import * as React from "react"
import { ChevronDown, ChevronUp, LogOut, Scale, UserRound } from "lucide-react"

import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLinkItem,
  MenuTrigger,
} from "@/components/ui/menu"
import {
  GuardedLink,
  useGuardedNavigate,
  useNavigationBlocker,
} from "@/components/navigation-blocker"
import { authClient } from "@/lib/auth-client"
import { clearDraftsForUser } from "@/lib/draft-store"
import type { SessionUser } from "@/lib/auth-session"
import { useRefresh } from "@/hooks/use-refresh"
import { useToast } from "@/components/ui/toast"

function nameParts(name: string) {
  return name.trim().split(/\s+/).filter(Boolean)
}

function firstName(name: string) {
  return nameParts(name)[0] ?? name
}

export function SidebarAccount({
  user,
  onNavigate,
}: {
  user: SessionUser
  onNavigate?: () => void
}) {
  const { go } = useGuardedNavigate()
  const { refresh } = useRefresh()
  const toast = useToast()
  const { confirmNavigation } = useNavigationBlocker()
  const [pending, setPending] = React.useState(false)

  const signOut = async () => {
    if (!(await confirmNavigation())) return
    setPending(true)
    const result = await authClient.signOut()
    if (result.error) {
      toast.add({
        title: "Couldn't sign out",
        description: result.error.message,
        type: "error",
      })
      setPending(false)
      return
    }
    clearDraftsForUser(user.id)
    void go("/login", { force: true })
    void refresh()
  }

  return (
    <Menu>
      {/* 40px row, radius 8, the same 9px gap as a nav item so the initial
          disc lands on the nav icon column and the name on the label one. */}
      <MenuTrigger className="group/account flex h-9 min-w-0 flex-1 items-center gap-[9px] rounded-lg border border-transparent px-2 text-left outline-none hover:bg-sidebar-hover focus-visible:border-foreground data-popup-open:bg-sidebar-hover">
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-xs leading-none font-semibold text-background"
        >
          {firstName(user.name).slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm leading-none font-medium text-sidebar-foreground">
          {firstName(user.name)}
        </span>
        {/* The chevron points at where the popover will go, so it flips when
            the popover is open rather than spinning. */}
        <ChevronDown
          className="size-[15px] shrink-0 group-data-popup-open/account:hidden"
          strokeWidth={2}
          aria-hidden="true"
        />
        <ChevronUp
          className="hidden size-[15px] shrink-0 group-data-popup-open/account:block"
          strokeWidth={2}
          aria-hidden="true"
        />
      </MenuTrigger>

      {/* The row sits at the foot of the sidebar, so its popover opens above,
          matched to the row's own width. */}
      <MenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-(--anchor-width) min-w-[184px]"
      >
        {/* Name over email on a #f4f4f5 rule — no avatar up here. */}
        <div className="border-b border-muted px-2.5 pt-2 pb-2.5">
          <p className="truncate text-base leading-none font-semibold">
            {user.name}
          </p>
          <p className="mt-1 truncate text-xs leading-none text-foreground">
            {user.email}
          </p>
        </div>

        <div className="flex flex-col gap-px pt-[5px]">
          <MenuLinkItem
            render={<GuardedLink href="/profile" />}
            onClick={onNavigate}
          >
            <UserRound
              className="text-current"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Your profile
          </MenuLinkItem>
          <MenuLinkItem
            render={<GuardedLink href="/source-and-legal" />}
            onClick={onNavigate}
          >
            <Scale
              className="text-current"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Source &amp; legal
          </MenuLinkItem>

          {/* Sign out is set off by a rule rather than a gap. */}
          <MenuItem
            disabled={pending}
            onClick={signOut}
            className="mt-1.5 rounded-t-none border-t border-muted"
          >
            <LogOut
              className="text-current"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Sign out
          </MenuItem>
        </div>
      </MenuContent>
    </Menu>
  )
}
