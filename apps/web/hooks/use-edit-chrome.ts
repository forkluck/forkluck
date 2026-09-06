import * as React from "react"

import { useNavigationBlocker } from "@/components/navigation-blocker"
import { useSaveShortcut } from "@/hooks/use-save-shortcut"
import type { SaveStatusState } from "@/components/ui/save-status"

/** What every edit header holds: the screen's save, its state, its dirt. */
export function useEditChrome() {
  const { setIsBlocked } = useNavigationBlocker()
  const [dirty, setDirtyState] = React.useState(false)
  const [saveState, setSaveState] = React.useState<SaveStatusState>("saved")
  // Only the cook's own press spins the button. A screen that saves itself
  // every few seconds would otherwise be unpressable half the time.
  const [savePending, setSavePending] = React.useState(false)
  // What the last press came to. Reads on the button for a moment and then
  // goes back to Save, the way Ghost's task button does.
  const [pressed, setPressed] = React.useState<"idle" | "saved" | "failed">(
    "idle"
  )
  const forget = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(
    () => () => {
      if (forget.current) clearTimeout(forget.current)
    },
    []
  )
  const saveRef = React.useRef<(() => Promise<unknown>) | null>(null)
  const inFlight = React.useRef(false)
  const latest = React.useRef({ dirty, saveState })
  React.useEffect(() => {
    latest.current = { dirty, saveState }
  })

  const setDirty = React.useCallback(
    (next: boolean) => {
      setDirtyState(next)
      setIsBlocked(next)
      if (next) setPressed("idle")
    },
    [setIsBlocked]
  )

  // One save at a time, whatever started it: a second press while one is
  // running would create a second record on a screen that has no id yet.
  const save = React.useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setSavePending(true)
    try {
      await saveRef.current?.()
    } finally {
      inFlight.current = false
      setSavePending(false)
    }
    const { dirty, saveState } = latest.current
    const next =
      saveState === "error" || saveState === "conflict"
        ? "failed"
        : dirty
          ? "idle"
          : "saved"
    setPressed(next)
    if (forget.current) clearTimeout(forget.current)
    if (next !== "idle")
      forget.current = setTimeout(() => setPressed("idle"), 2500)
  }, [])
  useSaveShortcut(save)

  return {
    dirty,
    setDirty,
    saveState,
    setSaveState,
    saveRef,
    savePending,
    saveLabel:
      pressed === "saved" ? "Saved" : pressed === "failed" ? "Retry" : "Save",
    save,
  }
}
