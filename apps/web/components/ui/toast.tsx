"use client"

import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Base UI's toast, wrapped the same way dialog/menu/select are — no extra
 * dependency, and one animation system across every overlay in the app.
 *
 * Mount <ToastProvider> once (the app shell does it) and raise toasts with
 * `useToast()` from anywhere below it:
 *
 *   const toast = useToast()
 *   toast.add({ title: "Saved" })
 *   toast.add({ title: "Couldn't save", type: "error" })
 */
function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <ToastPrimitive.Provider>
      {children}
      <ToastViewport />
    </ToastPrimitive.Provider>
  )
}

function ToastViewport() {
  return (
    <ToastPrimitive.Portal>
      <ToastPrimitive.Viewport className="fixed bottom-4 left-1/2 z-50 flex w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 outline-none">
        <ToastList />
      </ToastPrimitive.Viewport>
    </ToastPrimitive.Portal>
  )
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager()

  return toasts.map((toast) => (
    <ToastPrimitive.Root
      key={toast.id}
      toast={toast}
      className={cn(
        // The ink pill, same as the primary button: dark fill, light text, so
        // the toast reads as layered over the page instead of blending in.
        "relative flex flex-col gap-0.5 rounded-lg border border-transparent bg-foreground p-3 pr-9 text-md leading-5 text-background",
        "data-starting-style:translate-y-2 data-starting-style:opacity-0",
        "data-ending-style:translate-y-2 data-ending-style:opacity-0",
        "transition-[opacity,transform] duration-200 motion-reduce:transition-none",
        // `type` is free-form on Base UI's toast; "error" is our own
        // convention. --destructive is tuned for white and goes muddy on the
        // ink fill, so errors use --destructive-tint, the lighter step off the
        // same base.
        toast.type === "error" && "text-destructive-tint"
      )}
    >
      <ToastPrimitive.Title className="font-medium" />
      <ToastPrimitive.Description className="text-background/70" />
      <ToastPrimitive.Close
        aria-label="Dismiss"
        className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md border border-transparent text-background/70 hover:bg-background/15 hover:text-background focus-visible:border-background focus-visible:outline-none"
      >
        <XIcon className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  ))
}

const useToast = ToastPrimitive.useToastManager

export { ToastProvider, useToast }
