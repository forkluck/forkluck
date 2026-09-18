import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * One badge: 20px, the bottom rung of the control ladder, `rounded-md`, 500
 * 12px, tabular so a column of deltas lines up. It labels a row or a metric
 * and never acts, so it carries no shadow, no ring and no accent; focus turns
 * the border ink like every other control. An icon may lead the label, never
 * trail it.
 *
 * The semantic colors are the app's one green, one red and one amber, each
 * as ink on its pale fill. There used to be a second, cooler green for the
 * row chip; it failed AA on its own fill, so one of each serves every badge.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 text-xs font-medium whitespace-nowrap tabular-nums focus-visible:border-foreground has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        // Badges are grey by default — they label things, they don't act, so
        // they stay out of the accent (data, selection) and the ink of a
        // filled button. This is the handoff's `Package` badge.
        default:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary-strong",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary-strong",
        // A state on a row, not an action to take — the ink on a pale fill,
        // never the filled red of a destructive button.
        destructive: "bg-destructive-fill text-destructive-strong",
        // A metric moving the right way.
        success: "bg-success-fill text-success",
        // Needs attention: over target, unmatched, waiting on someone.
        warning: "bg-warning-fill text-warning-foreground",
        outline: "border-border text-foreground [a]:hover:border-line-strong",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
