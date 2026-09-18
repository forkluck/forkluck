import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The app's surface box promoted to a component: `rounded-xl` over one
 * `--border` hairline on the card fill, 20px of padding, 16px between the
 * blocks inside it. Cards, dialogs and the empty state share the 14px radius
 * step, which is what tells a surface apart from a control.
 *
 * `render` takes the whole card somewhere — `<Card render={<a href="…" />}>`
 * is the clickable card, whose hairline firms to `--line-strong` on hover and
 * turns ink on focus, because there is no focus ring anywhere in this design.
 * A card is not a control, so it sits off the 20/24/28/32/36 height ladder and
 * takes whatever height its content needs.
 *
 * `MetricCard`, `EmptyState` and the dialog keep their own shells; this is for
 * new call sites.
 */
function Card({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "flex flex-col gap-4 rounded-xl border border-border bg-card p-5 outline-none",
          "[a]:hover:border-line-strong [a]:focus-visible:border-foreground",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "card" },
  })
}

/** Title and description stacked at the top of a card. */
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-col gap-1", className)}
      {...props}
    />
  )
}

/** The card heading: 16px 600, the step the type scale reserves for it. */
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("text-md font-semibold text-foreground", className)}
      {...props}
    />
  )
}

/** The quiet line under the title: help-text size, muted ink. */
function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

/** The card's body. */
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("flex flex-col gap-2 text-base", className)}
      {...props}
    />
  )
}

/** The action row, laid out like a dialog footer: 8px gap, primary last. */
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  )
}

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle }
