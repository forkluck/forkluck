"use client"

import { cn } from "@/lib/utils"

export type SaveStatusState = "saved" | "saving" | "error" | "conflict"

/** What the header says about the last save. */
export function SaveStatus({
  state,
  dirty,
  saved,
  fallback = "",
}: {
  state: SaveStatusState
  dirty: boolean
  /** Whether the record exists on the server at all. */
  saved: boolean
  /** What a record with nothing saved yet reads as. */
  fallback?: string
}) {
  const failed = state === "error" || state === "conflict"
  return (
    <span
      role="status"
      aria-live="polite"
      // A fixed track: letting it resize nudges the title on every keystroke,
      // and it is wide enough for the longest label, "Changed elsewhere".
      className={cn(
        "w-32 shrink-0 text-xs",
        failed ? "text-destructive" : "text-faint"
      )}
    >
      {state === "saving"
        ? "Saving…"
        : state === "error"
          ? "Not saved"
          : state === "conflict"
            ? "Changed elsewhere"
            : dirty
              ? "Draft"
              : saved
                ? "Saved"
                : fallback}
    </span>
  )
}
