import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * The single activity mark for the app: one ring, spun, whose stroke tracks
 * its diameter — the handoff draws the full-page loader at 80px / 6px, so the
 * smaller sizes step the border down with the size rather than shrinking one
 * fixed ring. Reduced motion holds it still.
 *
 *   sm   16px / 2   inline, inside a control or a dense row
 *   md   32px / 3   a card or dialog slot standing in for content
 *   lg   80px / 6   the whole-viewport navigation spinner (`app/(app)/loading`)
 */
const spinnerVariants = cva(
  "animate-spin rounded-full border-muted border-t-foreground motion-reduce:animate-none",
  {
    variants: {
      size: {
        sm: "size-4 border-2",
        md: "size-8 border-[3px]",
        lg: "size-20 border-[6px]",
      },
    },
    defaultVariants: {
      size: "md",
    },
  }
)

/**
 * `role="status"` + an `sr-only` label announce the wait to assistive tech; the
 * spinning ring itself is decorative (`aria-hidden`). Callers that already sit
 * inside a labelled busy region can pass `label=""` to drop the extra text.
 *
 * `delayed` holds the ring invisible for its first 150ms. A route that is
 * already in the client cache arrives well inside that, and a spinner that
 * flashes for two frames reads as slower than a page that simply changed.
 * The wait is announced from the start either way.
 */
function Spinner({
  size,
  className,
  label = "Loading",
  delayed = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof spinnerVariants> & {
    label?: string
    delayed?: boolean
  }) {
  return (
    <span
      role="status"
      className={cn(
        "inline-grid place-items-center",
        delayed &&
          "animate-in delay-150 duration-200 fill-mode-backwards fade-in motion-reduce:animate-none",
        className
      )}
      {...props}
    >
      <span aria-hidden="true" className={spinnerVariants({ size })} />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}

export { Spinner, spinnerVariants }
