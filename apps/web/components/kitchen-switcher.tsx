"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ChefHat, ChevronDown, ChevronUp, LogOut } from "lucide-react"

import { leaveKitchen } from "@/app/(app)/settings/actions"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu"
import { useToast } from "@/components/ui/toast"
import { writeKitchenCookie, type ActiveKitchen } from "@/lib/kitchen"
import { useRefresh } from "@/hooks/use-refresh"

const ROLE_LABEL = { viewer: "Viewer", editor: "Editor" } as const

/** The account's own kitchen has no owner name to borrow. */
export function kitchenLabel(kitchen: ActiveKitchen | null) {
  return kitchen ? `${kitchen.ownerName}’s kitchen` : "My kitchen"
}

/**
 * The row above the account row: which kitchen the app is looking at. It sits
 * in the sidebar only for accounts that belong to one, so a single-tenant
 * account never sees a control with one choice in it.
 */
export function KitchenSwitcher({
  kitchens,
  active,
  onNavigate,
}: {
  kitchens: ActiveKitchen[]
  /** `null` is the account's own kitchen. */
  active: ActiveKitchen | null
  onNavigate?: () => void
}) {
  const router = useRouter()
  const { refresh } = useRefresh()
  const toast = useToast()
  const [confirmLeave, setConfirmLeave] = React.useState(false)
  const [pending, setPending] = React.useState(false)

  // The cookie is the only record of the pick, so every kitchen change goes
  // back to Recipes: it is the one screen a member has.
  const pick = (kitchen: ActiveKitchen | null) => {
    writeKitchenCookie(kitchen?.ownerId ?? null)
    onNavigate?.()
    router.push("/recipes")
    void refresh()
  }

  return (
    <>
      <Menu>
        {/* Same box as the account row under it — 36px, radius 10, a 17px
            glyph on the nav icon column — so the two read as one foot. */}
        <MenuTrigger className="group/kitchen flex h-9 min-w-0 flex-1 items-center gap-[9px] rounded-lg border border-transparent px-2 text-left outline-none hover:bg-sidebar-hover focus-visible:border-foreground data-popup-open:bg-sidebar-hover">
          <ChefHat
            className="size-[17px] shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-sm leading-none font-medium text-sidebar-foreground">
            {kitchenLabel(active)}
          </span>
          <ChevronDown
            className="size-[15px] shrink-0 group-data-popup-open/kitchen:hidden"
            strokeWidth={2}
            aria-hidden="true"
          />
          <ChevronUp
            className="hidden size-[15px] shrink-0 group-data-popup-open/kitchen:block"
            strokeWidth={2}
            aria-hidden="true"
          />
        </MenuTrigger>

        <MenuContent
          side="top"
          align="start"
          sideOffset={6}
          className="w-(--anchor-width) min-w-[184px]"
        >
          <div className="flex flex-col gap-px">
            <MenuCheckItem checked={active === null} onClick={() => pick(null)}>
              {kitchenLabel(null)}
            </MenuCheckItem>
            {kitchens.map((kitchen) => (
              <MenuCheckItem
                key={kitchen.id}
                checked={active?.id === kitchen.id}
                onClick={() => pick(kitchen)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {kitchenLabel(kitchen)}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {ROLE_LABEL[kitchen.role]}
                </span>
              </MenuCheckItem>
            ))}

            {/* Leaving is only on offer from inside the kitchen being left. */}
            {active ? (
              <MenuItem
                className="mt-1.5 rounded-t-none border-t border-muted"
                onClick={() => setConfirmLeave(true)}
              >
                <LogOut
                  className="text-current"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                Leave this kitchen
              </MenuItem>
            ) : null}
          </div>
        </MenuContent>
      </Menu>

      {active ? (
        <ConfirmDialog
          open={confirmLeave}
          onOpenChange={setConfirmLeave}
          title="Leave this kitchen?"
          description={`You lose access to ${active.ownerName}’s recipes.`}
          confirmLabel="Leave kitchen"
          pending={pending}
          onConfirm={async () => {
            setPending(true)
            try {
              const result = await leaveKitchen({ membershipId: active.id })
              if ("error" in result) {
                toast.add({ title: result.error, type: "error" })
                return
              }
              // Only once the membership is gone: a failed leave must not
              // drop the reader out of a kitchen they still belong to.
              writeKitchenCookie(null)
              setConfirmLeave(false)
              router.push("/recipes")
              void refresh()
            } finally {
              setPending(false)
            }
          }}
        />
      ) : null}
    </>
  )
}
