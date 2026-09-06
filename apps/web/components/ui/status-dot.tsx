import { cn } from "@/lib/utils"

/** A dot the same color as its label: green connected, grey off, yellow when
 *  the link needs attention, red when the last sync failed. */
export function StatusDot({
  label,
  tone,
}: {
  label: string
  tone: "on" | "off" | "attention" | "error"
}) {
  const text = {
    on: "text-success",
    off: "text-faint",
    attention: "text-warning-foreground",
    error: "text-destructive",
  }[tone]
  const dot = {
    on: "bg-success",
    off: "bg-disabled-foreground",
    attention: "bg-warning",
    error: "bg-destructive",
  }[tone]

  return (
    <span className={cn("flex items-center gap-[5px] text-xs", text)}>
      <span
        aria-hidden="true"
        className={cn("size-1.5 flex-none rounded-full", dot)}
      />
      {label}
    </span>
  )
}
