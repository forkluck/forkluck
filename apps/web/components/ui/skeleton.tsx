import { cn } from "@/lib/utils"

/**
 * A grey block standing in for content that is on its way, in the shape and
 * place the content will take. Size it at the call site (`h-4 w-2/3`); the
 * radius here is the field step, and a bubble passes `rounded-xl` to match
 * itself. Reduced motion holds it still. Decorative: the region around it
 * carries the `role="status"` and the sr-only label.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-muted motion-reduce:animate-none",
        className
      )}
    />
  )
}
