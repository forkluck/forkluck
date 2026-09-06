import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * Content that is about to be replaced. While `pending`, it dims behind one
 * activity mark near its top, where the control that was just clicked sits,
 * and stops taking clicks — the old numbers stay legible for orientation but
 * nobody mistakes them for the answer.
 */
export function LoadingRegion({
  pending,
  label,
  className,
  children,
}: {
  pending: boolean
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div aria-busy={pending || undefined} className="relative">
      {pending ? (
        <div className="pointer-events-none absolute inset-x-0 top-24 z-10 flex justify-center">
          <Spinner size="md" label={label} />
        </div>
      ) : null}
      <div
        className={cn(
          "transition-opacity",
          pending && "pointer-events-none opacity-40",
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}
