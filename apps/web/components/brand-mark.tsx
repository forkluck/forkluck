import { cn } from "@/lib/utils"

type BrandMarkProps = {
  className?: string
}

/**
 * The whole mark is the wordmark, 600 16px tightened a hair. It used to carry
 * a chef-hat glyph beside the type; the type stands alone now, and the sidebar
 * and the auth screens draw it through this one component so they cannot
 * drift apart again.
 */
export function BrandMark({ className }: BrandMarkProps) {
  return (
    <span
      className={cn(
        "block min-w-0 truncate text-lg leading-none font-semibold tracking-[-0.01em]",
        className
      )}
    >
      Forkluck
    </span>
  )
}
