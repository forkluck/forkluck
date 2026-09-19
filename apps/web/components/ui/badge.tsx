import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * One badge: 20px, the bottom rung of the control ladder, `rounded-md`, 550
 * 12px, tabular so a column of deltas lines up. It labels a row or a metric
 * and never acts, so it carries no shadow, no ring and no accent; focus turns
 * the border ink like every other control. An icon may lead the label, never
 * trail it.
 *
 * Six tones, each an ink on its pale fill: neutral (grey, the default), info
 * (blue), success (green), warning (orange), caution (yellow), critical
 * (red). Every pair clears 4.5:1 on its own fill; the numbers are beside the
 * tokens in globals.css.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-1.5 text-xs font-[550] whitespace-nowrap tabular-nums focus-visible:border-foreground has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-secondary text-secondary-foreground",
        info: "bg-info-fill text-info",
        success: "bg-success-fill text-success",
        warning: "bg-warning-fill text-warning-foreground",
        caution: "bg-caution-fill text-caution-foreground",
        critical: "bg-destructive-fill text-destructive-strong",
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
