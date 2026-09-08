"use client"

import * as React from "react"

import { useHydrated } from "@/hooks/use-hydrated"
import { cn } from "@/lib/utils"

/**
 * A key, as a chip: the Esc in the search field, the @ beside Mention, the
 * ⌘S in a tooltip over Save. Colour is inherited, so the same chip reads on
 * a white field, a menu row and the ink tooltip; the tooltip's own rules
 * pick it out by `data-slot="kbd"`.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "rounded-sm border border-current/25 px-1.5 py-[3px] font-sans text-2xs leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

/**
 * "⌘S" on a Mac, "Ctrl+S" everywhere else. Both listeners accept either
 * modifier; the hint names the one on the reader's keyboard. The server
 * cannot know the platform, so the first paint says Ctrl and the client
 * corrects it once it owns the page.
 */
function useShortcutLabel(key: string): string {
  const hydrated = useHydrated()
  const mac =
    hydrated &&
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? navigator.platform
    )
  return mac ? `⌘${key}` : `Ctrl+${key}`
}

export { Kbd, useShortcutLabel }
