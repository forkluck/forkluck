import * as React from "react"

import { GuardedLink } from "@/components/navigation-blocker"
import { cn } from "@/lib/utils"

/**
 * The two links in the app: body-size regular text in the brand blue, or in
 * the red for a link that destroys something, with no underline until it is
 * hovered or focused. Blue is otherwise reserved for data and selection, so a
 * link is the one place it appears as text to read. There is no third link:
 * a link-shaped button or badge is one of these.
 *
 * `TextLink` is the in-app link (it goes through `GuardedLink`, so an
 * unsaved form can stop it). A plain `<a>` to another site, or a `<button>`
 * that reads as a link, takes `linkClassName` instead.
 */
export const linkClassName =
  "rounded-sm text-md text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"

export const criticalLinkClassName =
  "rounded-sm text-md text-destructive underline-offset-4 outline-none hover:underline focus-visible:underline"

export function TextLink({
  tone = "default",
  className,
  ...props
}: React.ComponentProps<typeof GuardedLink> & {
  tone?: "default" | "critical"
}) {
  return (
    <GuardedLink
      className={cn(
        tone === "critical" ? criticalLinkClassName : linkClassName,
        className
      )}
      {...props}
    />
  )
}
