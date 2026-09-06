import * as React from "react"
import { TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The needs-attention banner: a 48px yellow strip that sits between a screen's
 * toolbar and its table (`DataTable`'s `notice` slot puts it there). `rounded-lg`
 * on `--warning-fill` over `--warning-border`, a 16px triangle in `--warning`,
 * 13.5px `--warning-foreground` copy, and a ghost action pinned right.
 *
 * Products, Invoices and Ingredients each drew their own in the first pass and
 * ended up with three different heights.
 */
function NoticeBanner({
  children,
  action,
  className,
  ...props
}: React.ComponentProps<"div"> & { action?: React.ReactNode }) {
  return (
    <div
      data-slot="notice-banner"
      className={cn(
        "mb-3 flex h-12 items-center gap-2.5 rounded-lg border border-warning-border bg-warning-fill px-3.5",
        className
      )}
      {...props}
    >
      <TriangleAlert
        className="size-4 shrink-0 text-warning"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-base text-warning-foreground">
        {children}
      </span>
      {action}
    </div>
  )
}

/**
 * The banner's own button: the ordinary outline button (grey line, white
 * fill), the same shell as the toolbar pills beside it. The banner's yellow
 * is the message's, not the button's.
 */
function NoticeBannerAction({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      className={cn("ml-auto shrink-0", className)}
      {...props}
    />
  )
}

export { NoticeBanner, NoticeBannerAction }
