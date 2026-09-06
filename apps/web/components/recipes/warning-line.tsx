import type * as React from "react"
import { TriangleAlert } from "lucide-react"

/**
 * The line the handoff uses wherever something is incomplete rather than
 * wrong: a 15px yellow triangle and one sentence naming the gap.
 */
export function WarningLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <TriangleAlert
        className="mt-px size-[15px] shrink-0 text-warning"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="text-sm leading-[1.55] text-warning-foreground">
        {children}
      </span>
    </div>
  )
}
