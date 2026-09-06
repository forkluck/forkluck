import * as React from "react"

import { useSaveQueue } from "@/hooks/use-save-queue"
import type { SaveFailure } from "@/lib/save-failure"

/** How long the form has to sit still before a draft saves itself. */
const QUIET_MS = 3000
/** A cook who never stops typing still gets a save this often. */
const FORCE_MS = 60000

type Options = {
  /**
   * A string that changes whenever the form changes. The same value twice
   * means nothing happened, so nothing is scheduled.
   */
  snapshot: string
  /** Whether there is anything worth saving right now. */
  active: boolean
  /** Save at once rather than waiting for the quiet spell. */
  immediate?: boolean
  /** Resolves null when the save landed. */
  save: () => Promise<SaveFailure | null>
}

/** The timer over the save queue: 3 s after the last change, and every 60 s
 * while changes keep coming. */
export function useAutosave({
  snapshot,
  active,
  immediate = false,
  save,
}: Options): () => Promise<SaveFailure | null> {
  const saveNow = useSaveQueue({ snapshot, save })

  React.useEffect(() => {
    if (!active) return
    if (immediate) {
      void saveNow()
      return
    }
    const timer = window.setTimeout(() => void saveNow(), QUIET_MS)
    return () => window.clearTimeout(timer)
  }, [snapshot, active, immediate, saveNow])

  // Deliberately restarted by nothing: the point of this one is that it fires
  // even while the quiet timer above is being pushed back by every keystroke,
  // and every quiet save that lands would otherwise reset its clock.
  const isActive = React.useRef(active)
  React.useEffect(() => {
    isActive.current = active
  }, [active])
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (isActive.current) void saveNow()
    }, FORCE_MS)
    return () => window.clearInterval(timer)
  }, [saveNow])

  return saveNow
}
