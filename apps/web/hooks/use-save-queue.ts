import * as React from "react"

import { toSaveFailure, type SaveFailure } from "@/lib/save-failure"

type Options = {
  /** A string that changes whenever the form changes. */
  snapshot: string
  /** Resolves null when the save landed. It is never called twice at once. */
  save: () => Promise<SaveFailure | null>
}

/**
 * One save in flight; a change made during one queues exactly one more, sent
 * with what the form says then. A throw becomes a `SaveFailure`.
 */
export function useSaveQueue({
  snapshot,
  save,
}: Options): () => Promise<SaveFailure | null> {
  // Read at save time, so a queued save sends what the form says then rather
  // than what it said when the timer was set.
  const latest = React.useRef(save)
  const current = React.useRef(snapshot)
  React.useEffect(() => {
    latest.current = save
    current.current = snapshot
  })

  const running = React.useRef<Promise<SaveFailure | null> | null>(null)
  const queued = React.useRef(false)
  const covered = React.useRef(snapshot)
  const conflict = React.useRef<SaveFailure | null>(null)

  const saveNow = React.useCallback((): Promise<SaveFailure | null> => {
    // Resending the same stale version would only be refused again: the queue
    // waits for the cook to reload or discard.
    if (conflict.current) return Promise.resolve(conflict.current)
    if (running.current) {
      // A second ask for what is already on its way, a blur during the
      // create say, rides along rather than sending it all twice.
      if (current.current !== covered.current) queued.current = true
      return running.current
    }
    const drain = async () => {
      let failure: SaveFailure | null = null
      do {
        queued.current = false
        covered.current = current.current
        try {
          failure = await latest.current()
        } catch (error) {
          failure = toSaveFailure(error)
        }
        if (failure?.kind === "conflict") {
          conflict.current = failure
          return failure
        }
      } while (queued.current)
      return failure
    }
    const started = drain().finally(() => {
      running.current = null
      queued.current = false
    })
    running.current = started
    return started
  }, [])

  return saveNow
}
