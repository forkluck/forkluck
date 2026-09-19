import * as React from "react"
import { Check, CircleAlert, Info, TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The banner: a 48px strip between a screen's toolbar and its content
 * (`DataTable`'s `notice` slot puts it there), `rounded-lg`, an icon, one line
 * of copy and a ghost action pinned right. Four tones, each the tone's fill
 * with its ink for the icon and the text: info, success, warning (the
 * default, and the one the screens use today) and critical.
 *
 * Products, Invoices and Ingredients each drew their own in the first pass and
 * ended up with three different heights.
 */
const TONES = {
  info: {
    icon: Info,
    className: "border-info/15 bg-info-fill text-info",
  },
  success: {
    icon: Check,
    className: "border-success/15 bg-success-fill text-success",
  },
  warning: {
    icon: TriangleAlert,
    className: "border-warning-border bg-warning-fill text-warning-foreground",
  },
  critical: {
    icon: CircleAlert,
    className:
      "border-destructive-strong/15 bg-destructive-fill text-destructive-strong",
  },
} as const

function NoticeBanner({
  tone = "warning",
  children,
  action,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: keyof typeof TONES
  action?: React.ReactNode
}) {
  const { icon: Icon, className: toneClassName } = TONES[tone]
  return (
    <div
      data-slot="notice-banner"
      data-tone={tone}
      className={cn(
        "mb-3 flex h-12 items-center gap-2.5 rounded-lg border px-3.5",
        toneClassName,
        className
      )}
      {...props}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      {/* A shade under the tone ink, so the copy reads a little darker than
          the badge that shares its colour without a second token. */}
      <span className="min-w-0 flex-1 truncate text-md text-[color-mix(in_oklab,currentColor_85%,black)]">
        {children}
      </span>
      {action}
    </div>
  )
}

/**
 * The banner's own button: the ghost, so the strip stays one calm fill with
 * the action reading as text until it is hovered. Trying this on the
 * owner's ask; the outline it replaced is one word away.
 */
function NoticeBannerAction({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      className={cn("ml-auto shrink-0", className)}
      {...props}
    />
  )
}

export { NoticeBanner, NoticeBannerAction }
