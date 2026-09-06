import { cn } from "@/lib/utils"

export function Marker({
  children,
  live = false,
  className,
}: {
  children: React.ReactNode
  live?: boolean
  className?: string
}) {
  return (
    <div
      role={live ? "status" : undefined}
      className={cn(
        "flex items-center gap-2 text-xs leading-4 text-muted-foreground",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-border",
          live && "animate-pulse bg-foreground"
        )}
      />
      {children}
    </div>
  )
}
