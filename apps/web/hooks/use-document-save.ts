import * as React from "react"

import { useNavigationBlocker } from "@/components/navigation-blocker"
import type { SaveStatusState } from "@/components/ui/save-status"
import { useAutosave } from "@/hooks/use-autosave"
import {
  clearDraft,
  draftKey,
  readDraft,
  writeDraft,
  type DraftKind,
} from "@/lib/draft-store"
import { toSaveFailure, type SaveFailure } from "@/lib/save-failure"

/** What a save that landed answers with. */
export type SaveEcho = {
  /** The record's version after the write, sent back as the next expectation. */
  editVersion?: number
  /** Server values worth taking. Skipped when the form moved on meanwhile. */
  adopt?: () => void
}

type Options = {
  /** A string that changes whenever the form changes. */
  snapshot: string
  /** Whether there is anything worth saving on a timer right now. */
  active: boolean
  /** Save at once rather than waiting out the quiet spell. */
  immediate?: boolean
  /** False while the form holds a value this save leaves behind. */
  wholeForm: boolean
  kind: DraftKind
  /** The workspace the record belongs to, which is its owner. */
  workspaceId: string
  userId: string
  /** Null until the first save lands. */
  recordId: string | null
  /** Null for a record the server has never seen. */
  editVersion: number | null
  /** The allowlisted recovery payload, read whenever a draft is written. */
  payload: () => unknown
  setDirty: (dirty: boolean) => void
  setSaveState: (state: SaveStatusState) => void
  /** `leaving` is a save on the way off the page: it must not navigate. */
  save: (
    expectedEditVersion: number | null,
    leaving: boolean
  ) => Promise<SaveEcho | SaveFailure>
}

type DocumentSave = {
  /** Saves now and resolves with what happened. */
  saveNow: () => Promise<SaveFailure | null>
  /** Set once the server refused a stale write, and never cleared. */
  conflict: SaveFailure | null
  /** A recovery copy this browser kept that the server does not have. */
  restorable: unknown
  /** Hides the restore banner, keeping the copy for the next save to clear. */
  dismissRestore: () => void
  /** Drops the recovery copy and hides the banner. */
  discardDraft: () => void
}

/** One request at a time; the baseline only ever advances to what was sent. */
export function useDocumentSave({
  snapshot,
  active,
  immediate,
  wholeForm,
  kind,
  workspaceId,
  userId,
  recordId,
  editVersion,
  payload,
  setDirty,
  setSaveState,
  save,
}: Options): DocumentSave {
  const { beforeLeaveRef } = useNavigationBlocker()
  // What the server holds. Only ever advances to a snapshot a save sent.
  const [baseline, setBaseline] = React.useState(snapshot)
  const latest = React.useRef(snapshot)
  const version = React.useRef(editVersion)
  const state = React.useRef<SaveStatusState>("saved")
  const [conflict, setConflict] = React.useState<SaveFailure | null>(null)
  // A uuid of its own, so two new tabs never share a slot. Blank on the server.
  const [draftUuid] = React.useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("draft") ??
        crypto.randomUUID())
  )
  const [restorable, setRestorable] = React.useState<unknown>(null)
  // Read by the draft-write effect in the same commit that offers the copy.
  const restorableRef = React.useRef<unknown>(null)
  const offerRestore = (payload: unknown) => {
    restorableRef.current = payload
    setRestorable(payload)
  }

  const dirty = snapshot !== baseline
  const slot = recordId ?? (draftUuid ? `new:${draftUuid}` : null)
  const key =
    slot === null ? null : draftKey({ workspaceId, userId, kind, id: slot })

  // Read at save time rather than closed over when the timer was set.
  const current = React.useRef({ wholeForm, save, payload })
  React.useEffect(() => {
    current.current = { wholeForm, save, payload }
  })

  React.useEffect(() => {
    latest.current = snapshot
    setDirty(snapshot !== baseline)
  }, [baseline, snapshot, setDirty])

  const setState = (next: SaveStatusState) => {
    state.current = next
    setSaveState(next)
  }

  // A save the navigation guard asked for: whoever is leaving owns the route.
  const leaving = React.useRef(false)

  const run = async (): Promise<SaveFailure | null> => {
    // Read before the first await: only this much reaches the server.
    const sent = latest.current
    setState("saving")
    let result: SaveEcho | SaveFailure
    try {
      result = await current.current.save(version.current, leaving.current)
    } catch (error) {
      result = toSaveFailure(error)
    }
    if ("kind" in result) {
      if (result.kind === "conflict") {
        setConflict(result)
        setState("conflict")
      } else {
        // Validation stops before the request, so the form is still a draft.
        setState(result.kind === "validation" ? "saved" : "error")
      }
      return result
    }
    if (result.editVersion !== undefined) version.current = result.editVersion
    if (latest.current === sent) result.adopt?.()
    // A save that left a half-typed pair behind does not get to say Saved.
    if (current.current.wholeForm) setBaseline(sent)
    setState("saved")
    return null
  }

  const saveNow = useAutosave({
    snapshot,
    active: active && conflict === null,
    immediate,
    save: run,
  })

  React.useEffect(() => {
    beforeLeaveRef.current = async () => {
      leaving.current = true
      try {
        return (await saveNow()) === null
      } finally {
        leaving.current = false
      }
    }
    return () => {
      beforeLeaveRef.current = null
    }
  }, [beforeLeaveRef, saveNow])

  React.useEffect(() => () => setDirty(false), [setDirty])

  React.useEffect(() => {
    if (recordId !== null || !draftUuid || !dirty) return
    const url = new URL(window.location.href)
    if (url.searchParams.get("draft") === draftUuid) return
    url.searchParams.set("draft", draftUuid)
    window.history.replaceState(null, "", url)
  }, [dirty, draftUuid, recordId])

  const checked = React.useRef(false)
  React.useEffect(() => {
    if (key === null || checked.current) return
    checked.current = true
    const draft = readDraft(key)
    if (
      draft &&
      JSON.stringify(draft.payload) !==
        JSON.stringify(current.current.payload())
    ) {
      offerRestore(draft.payload)
    }
  }, [key])

  // The slot moves to the persisted id on the first successful save; the
  // recovery copy under the old one has nothing left to recover.
  const previousKey = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (key === null) return
    if (previousKey.current !== null && previousKey.current !== key) {
      clearDraft(previousKey.current)
    }
    previousKey.current = key
  }, [key])

  React.useEffect(() => {
    if (key === null) return
    if (dirty) writeDraft(key, current.current.payload())
    else if (state.current === "saved" && restorableRef.current === null)
      clearDraft(key)
  })

  return {
    saveNow,
    conflict,
    restorable,
    dismissRestore: () => offerRestore(null),
    discardDraft: () => {
      if (key !== null) clearDraft(key)
      offerRestore(null)
    },
  }
}
