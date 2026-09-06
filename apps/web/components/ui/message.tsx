import { cn } from "@/lib/utils"

export function Message({
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
      data-from={from}
      className={cn(
        "flex w-full",
        from === "user" ? "justify-end" : "justify-start",
        className
      )}
    >
      {children}
    </div>
  )
}
