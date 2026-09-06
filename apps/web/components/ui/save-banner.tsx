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
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/50 px-4 py-3">
      <p className="text-sm text-foreground">{text}</p>
      <div className="flex gap-2">{children}</div>
    </div>
  )
}
