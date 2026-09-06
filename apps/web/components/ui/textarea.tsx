import * as React from "react"

import { cn } from "@/lib/utils"

/** The Input's edges and states, grown to hold wrapped text. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-card px-3 py-2 text-lg leading-6 text-foreground outline-none placeholder:text-faint focus-visible:border-foreground enabled:not-focus:hover:border-line-strong disabled:cursor-not-allowed disabled:border-border disabled:bg-fill-soft disabled:text-faint aria-invalid:border-destructive md:text-md",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
