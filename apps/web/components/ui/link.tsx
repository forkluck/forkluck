import * as React from "react"

import { GuardedLink } from "@/components/navigation-blocker"
import { cn } from "@/lib/utils"

/**
 * The one link in the app: regular text in the brand blue, no underline
 * until it is hovered or focused. Blue is otherwise reserved for data and
 * selection, so a link is the one place it appears as text to read.
 *
 * `TextLink` is the in-app link (it goes through `GuardedLink`, so an
 * unsaved form can stop it). A plain `<a>` to another site takes
 * `linkClassName` instead.
 */
export const linkClassName =
  "rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"

export function TextLink({
  className,
  ...props
}: React.ComponentProps<typeof GuardedLink>) {
  return <GuardedLink className={cn(linkClassName, className)} {...props} />
}
