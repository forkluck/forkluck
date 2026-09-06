import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * One height — 20px, the bottom rung of the control ladder — and two shapes,
 * 500 weight, tabular so a column of deltas lines up:
 *
 *   size="default"  the metric badge — `rounded-full`, 12.5px
 *   size="row"      a chip inside a table row — `rounded-md`, 11.5px
 *
 * Both sizes take the same semantic colors. There used to be a second, cooler
 * green for the row chip; it failed AA on its own fill, so one green and one
 * red now serve every badge in the app.
 *
 * The Recipes food-cost chip is the row size at 12px
 * (`size="row" className="text-xs"`); the small grey row tag (`Package`)
 * is `size="row" className="rounded-sm px-[7px] text-2xs"`.
 *
 * Badges label, they never act, so they carry no shadow, no ring, and no
 * accent — focus turns the border ink like every other control.
 */
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden border border-transparent px-2 font-medium whitespace-nowrap tabular-nums focus-visible:border-foreground has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      size: {
        default: "h-5 rounded-full text-xs",
        row: "h-5 rounded-md text-2xs",
      },
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
        destructive: "bg-destructive-fill text-destructive",
        // A metric moving the right way.
        success: "bg-success-fill text-success",
        // Needs attention: over target, unmatched, waiting on someone.
        warning: "bg-warning-fill text-warning-foreground",
        outline: "border-border text-foreground [a]:hover:border-line-strong",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, size }), className),
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
