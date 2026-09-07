"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

/**
 * The scrim is the one piece of depth in the whole design — there are no
 * shadows, so a modal reads as "above" only because the page dims behind it.
 * `--foreground` at 28% is the handoff's rgba(24,24,27,.28). No blur.
 *
 * Scrim and card fade over 150 ms, in and out, and nothing else moves: no
 * scale, no slide. A dialog that pops in one frame reads as instant, and a
 * delete that popped, vanished and was done in one frame read as free; the
 * fade gives the interaction a middle. The same Base UI starting and ending
 * styles the toast uses; reduced motion turns it off.
 */
const DIALOG_FADE =
  "transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none"

/**
 * How long the fade out takes, for a screen that mounts a dialog only while
 * it is open: hold the dialog's target this long after letting it go, so the
 * dialog can leave before it unmounts, and the next open still seeds fresh.
 *
 *   const held = useDialogTarget(deleteTarget)
 *   {held ? <DeleteDialog key={held.id} target={held} open={deleteTarget !== null} … /> : null}
 */
const DIALOG_EXIT_MS = 150

function useDialogTarget<T>(target: T | null): T | null {
  const [held, setHeld] = React.useState(target)
  // A new target is taken in render, at once; only letting go waits.
  if (target !== null && held !== target) setHeld(target)
  React.useEffect(() => {
    if (target !== null) return
    const timer = window.setTimeout(() => setHeld(null), DIALOG_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [target])
  return target ?? held
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-foreground/28",
        DIALOG_FADE,
        className
      )}
      {...props}
    />
  )
}

/**
 * Card: white, one 1px hairline, `rounded-xl`, padding 24. Width comes from
 * the `size` prop below, never from a number in `className`.
 *
 * The 18px grid gap is the header-to-body rhythm; the footer adds the extra
 * 2px that brings it to the handoff's 20px top margin.
 *
 * Padding comes from `--dialog-px` / `--dialog-py` so the close button can sit
 * on it: a variant with different padding (the 720px editor's `26px 28px`)
 * sets `[--dialog-px:28px] [--dialog-py:26px]` and the button follows. Only
 * the bottom differs often enough to be worth a plain `pb-*` override.
 */
const DIALOG_SIZES = {
  sm: "sm:max-w-[470px]",
  md: "sm:max-w-[560px]",
  lg: "sm:max-w-[760px]",
  xl: "sm:max-w-[1000px]",
  full: "sm:max-w-[1360px]",
} as const

function DialogContent({
  className,
  children,
  showCloseButton = true,
  size = "sm",
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  size?: keyof typeof DIALOG_SIZES
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-[18px] overflow-y-auto rounded-xl border border-border bg-card px-(--dialog-px) py-(--dialog-py) text-md leading-5 text-card-foreground outline-none [--dialog-px:24px] [--dialog-py:24px]",
          DIALOG_FADE,
          DIALOG_SIZES[size],
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            aria-label="Close"
            // 34px icon button, `rounded-lg`, transparent until hover. Sits on the
            // card's own padding so its box tops out level with the title row
            // whatever that padding is.
            className="absolute top-(--dialog-py) right-(--dialog-px) flex size-9 flex-none items-center justify-center rounded-lg border border-transparent text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:border-foreground"
          >
            <XIcon className="size-[19px]" strokeWidth={2} />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

/**
 * `min-h-9` keeps the title row as tall as the close button whether or
 * not there is a description, and the right padding reserves the button's
 * lane so a long title never runs under it.
 */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex min-h-9 flex-col justify-center gap-2 pr-[50px]",
        className
      )}
      {...props}
    />
  )
}

/** Right-aligned, 20px above — no divider. */
function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "mt-0.5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-xl leading-none font-semibold tracking-[-0.01em] text-foreground",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-base leading-[1.6] text-muted-foreground *:[a]:underline *:[a]:underline-offset-4 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  useDialogTarget,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
