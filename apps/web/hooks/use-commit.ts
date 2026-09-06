import * as React from "react"

import type { SaveStatusState } from "@/components/ui/save-status"
import { toSaveFailure, type SaveFailure } from "@/lib/save-failure"

/** What an action answers with: an `{error}`, or what it wrote. */
type CommitResult =
  { error: string } | { ok: true; editVersion?: number | null }

export type Commit = {
  /** `<kind>:<id>:<collection>`: two writes to one domain never overlap. */
  domain: string
  /** Put the new value on screen. */
  apply: () => void
  /** Put the whole domain back to the state this write started from. */
  revert: () => void
  write: () => Promise<CommitResult>
}

type Queue = {
  running: boolean
  /** The latest value waiting to be sent; a newer one replaces it. */
  desired: Commit | null
  /** Callers waiting on a value that has not been answered yet. */
  waiting: ((failure: SaveFailure | null) => void)[]
  /** Back to the confirmed value; null when that is what is on screen. */
  confirmed: (() => void) | null
  /** Revert of the first entry queued behind the running one. */
  desiredRevert: (() => void) | null
}

type Options = {
  /** A chrome's pill: what every domain together is doing. */
  onSaveState?: (state: SaveStatusState) => void
  /** After every write that landed, so the screen can refetch. */
  onSaved?: () => void
  /** The version a write echoed, when its domain bumps the record. */
  onVersion?: (version: number) => void
}

/** Controls that save themselves: one write per conflict domain, coalescing. */
export function useCommit({ onSaveState, onSaved, onVersion }: Options) {
  const handlers = React.useRef({ onSaveState, onSaved, onVersion })
  React.useEffect(() => {
    handlers.current = { onSaveState, onSaved, onVersion }
  })
  const queues = React.useRef(new Map<string, Queue>())
  const running = React.useRef(0)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const drain = React.useCallback(async (queue: Queue) => {
    while (queue.desired) {
      const entry = queue.desired
      const waiting = queue.waiting
      queue.desired = null
      queue.desiredRevert = null
      queue.waiting = []
      running.current += 1
      handlers.current.onSaveState?.("saving")
      let failure: SaveFailure | null = null
      let version: number | null = null
      try {
        const result = await entry.write()
        if ("error" in result) failure = toSaveFailure(result)
        else if (typeof result.editVersion === "number")
          version = result.editVersion
      } catch (error) {
        failure = toSaveFailure(error)
      }
      if (!mounted.current) return
      running.current -= 1
      // Whatever the user queued while this write was in flight.
      const queued = queue.desired as Commit | null
      if (failure) {
        // A newer value is already on its way: it says what stays on screen.
        if (!queued) {
          queue.confirmed?.()
          queue.confirmed = null
        }
        handlers.current.onSaveState?.("error")
      } else {
        // The first entry queued behind this write captured its revert before
        // it applied, so it holds the value the server just confirmed.
        queue.confirmed = queued ? queue.desiredRevert : null
        if (version !== null) handlers.current.onVersion?.(version)
        if (running.current === 0) handlers.current.onSaveState?.("saved")
        handlers.current.onSaved?.()
      }
      for (const resolve of waiting) resolve(failure)
    }
    queue.running = false
  }, [])

  return React.useCallback(
    (entry: Commit) => {
      const known = queues.current.get(entry.domain)
      const queue: Queue = known ?? {
        running: false,
        desired: null,
        waiting: [],
        confirmed: null,
        desiredRevert: null,
      }
      if (!known) queues.current.set(entry.domain, queue)
      entry.apply()
      // The first attempt since the last success is the one that knows what
      // the server holds.
      if (queue.confirmed === null) queue.confirmed = entry.revert
      if (queue.desired === null) queue.desiredRevert = entry.revert
      queue.desired = entry
      const answered = new Promise<SaveFailure | null>((resolve) =>
        queue.waiting.push(resolve)
      )
      if (!queue.running) {
        queue.running = true
        void drain(queue)
      }
      return answered
    },
    [drain]
  )
}
