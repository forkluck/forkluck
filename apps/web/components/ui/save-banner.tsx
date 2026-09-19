"use client"

/** The strip above an editor when a save needs the cook to decide something. */
export function SaveBanner({
  text,
  children,
}: {
  text: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-fill-soft px-3.5 py-2.5">
      <p className="text-md text-foreground">{text}</p>
      <div className="flex gap-2">{children}</div>
    </div>
  )
}
