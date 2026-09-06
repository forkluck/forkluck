"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type NavigationBlockerValue = {
  isBlocked: boolean
  setIsBlocked: React.Dispatch<React.SetStateAction<boolean>>
  /**
   * A screen that can save on the way out puts its save here. It runs before
   * an attempted navigation and, when it resolves true, the navigation goes
   * through with nothing asked. Only a save that failed reaches the dialog.
   */
  beforeLeaveRef: React.RefObject<(() => Promise<boolean>) | null>
  confirmNavigation: () => Promise<boolean>
  allowNavigation: () => void
}

const NavigationBlockerContext = React.createContext<NavigationBlockerValue>({
  isBlocked: false,
  setIsBlocked: () => undefined,
  beforeLeaveRef: { current: null },
  confirmNavigation: () => Promise.resolve(true),
  allowNavigation: () => undefined,
})

type BrowserNavigationType = "push" | "replace" | "reload" | "traverse"

type BrowserNavigationEvent = Event & {
  canIntercept: boolean
  destination: {
    key: string
    url: string
  }
  downloadRequest: string | null
  hashChange: boolean
  navigationType: BrowserNavigationType
}

type BrowserNavigation = EventTarget & {
  traverseTo: (key: string) => unknown
}

export function NavigationBlockerProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [isBlocked, setIsBlocked] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const allowNextNavigation = React.useRef(false)
  const beforeLeaveRef = React.useRef<(() => Promise<boolean>) | null>(null)
  const pendingConfirmation = React.useRef<
    ((confirmed: boolean) => void) | null
  >(null)

  const permitNextNavigation = React.useCallback(() => {
    allowNextNavigation.current = true
    window.setTimeout(() => {
      allowNextNavigation.current = false
    }, 0)
  }, [])

  const resolveConfirmation = React.useCallback((confirmed: boolean) => {
    const resolve = pendingConfirmation.current
    pendingConfirmation.current = null
    setDialogOpen(false)
    resolve?.(confirmed)
  }, [])

  const allowNavigation = React.useCallback(() => {
    permitNextNavigation()
    setIsBlocked(false)
    setDialogOpen(false)
    pendingConfirmation.current?.(false)
    pendingConfirmation.current = null
  }, [permitNextNavigation])

  const confirmNavigation = React.useCallback(async () => {
    if (!isBlocked) return true

    // Saving is the answer to "you have unsaved changes", so the screen gets
    // to try before anyone is asked anything.
    const beforeLeave = beforeLeaveRef.current
    if (beforeLeave && (await beforeLeave())) return true

    pendingConfirmation.current?.(false)
    return new Promise<boolean>((resolve) => {
      pendingConfirmation.current = resolve
      setDialogOpen(true)
    })
  }, [isBlocked])

  React.useEffect(() => {
    if (isBlocked) allowNextNavigation.current = false
  }, [isBlocked])

  React.useEffect(() => {
    if (!isBlocked) return

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowNextNavigation.current) return
      // Unload cannot wait for a save, so dirty always prompts — save-on-leave
      // included.
      event.preventDefault()
      event.returnValue = ""
    }

    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [isBlocked])

  React.useEffect(() => {
    if (!isBlocked) return

    // The Navigation API lets supporting browsers use the app dialog for
    // back/forward. Push and replace are not interceptable here: the router
    // commits the new page first and only syncs history afterwards, so their
    // navigate event arrives too late to stop. Those go through GuardedLink.
    // Reloads and cross-origin exits still use beforeunload because browsers
    // require their own prompt.
    const navigation = (window as Window & { navigation?: BrowserNavigation })
      .navigation
    if (!navigation) return

    const onNavigate = (event: Event) => {
      const navigationEvent = event as BrowserNavigationEvent
      if (
        !navigationEvent.canIntercept ||
        navigationEvent.downloadRequest ||
        navigationEvent.hashChange ||
        navigationEvent.navigationType !== "traverse" ||
        !navigationEvent.destination.key
      ) {
        return
      }

      if (allowNextNavigation.current) {
        allowNextNavigation.current = false
        return
      }

      event.preventDefault()
      void confirmNavigation().then((confirmed) => {
        if (!confirmed) return
        allowNavigation()
        navigation.traverseTo(navigationEvent.destination.key)
      })
    }

    navigation.addEventListener("navigate", onNavigate)
    return () => navigation.removeEventListener("navigate", onNavigate)
  }, [allowNavigation, confirmNavigation, isBlocked])

  React.useEffect(
    () => () => {
      pendingConfirmation.current?.(false)
    },
    []
  )

  const value = React.useMemo(
    () => ({
      isBlocked,
      setIsBlocked,
      beforeLeaveRef,
      confirmNavigation,
      allowNavigation,
    }),
    [allowNavigation, confirmNavigation, isBlocked]
  )

  return (
    <NavigationBlockerContext.Provider value={value}>
      {children}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) resolveConfirmation(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave without saving?</DialogTitle>
            <DialogDescription>
              Your changes haven&rsquo;t been saved. If you leave now,
              they&rsquo;ll be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => resolveConfirmation(false)}
            >
              Stay
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => resolveConfirmation(true)}
            >
              Leave without saving
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </NavigationBlockerContext.Provider>
  )
}

export function useNavigationBlocker() {
  return React.useContext(NavigationBlockerContext)
}

type GuardedLinkProps = Omit<React.ComponentProps<typeof Link>, "href"> & {
  href: string
}

export const GuardedLink = React.forwardRef<
  HTMLAnchorElement,
  GuardedLinkProps
>(function GuardedLink(
  { href, onNavigate, replace, scroll, transitionTypes, ...props },
  ref
) {
  const router = useRouter()
  const { allowNavigation, confirmNavigation, isBlocked } =
    useNavigationBlocker()

  return (
    <Link
      ref={ref}
      {...props}
      href={href}
      replace={replace}
      scroll={scroll}
      transitionTypes={transitionTypes}
      onNavigate={(event) => {
        onNavigate?.(event)
        if (!isBlocked) return

        event.preventDefault()
        void confirmNavigation().then((confirmed) => {
          if (!confirmed) return

          allowNavigation()
          const options = { scroll, transitionTypes }
          if (replace) {
            router.replace(href, options)
          } else {
            router.push(href, options)
          }
        })
      }}
    />
  )
})
