import { cn } from "@/lib/utils"

export function Bubble({
  from,
  children,
  className,
}: {
  from: "user" | "assistant"
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "max-w-full min-w-0 text-md leading-6 whitespace-pre-wrap",
        from === "user"
          ? "max-w-[88%] rounded-xl bg-muted px-3.5 py-2.5 text-foreground"
          : "text-foreground",
        className
      )}
    >
      {children}
    </div>
  )
}
