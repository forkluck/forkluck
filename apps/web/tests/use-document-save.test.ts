// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

import { useDocumentSave, type SaveEcho } from "@/hooks/use-document-save"
import { draftKey, writeDraft } from "@/lib/draft-store"
import type { SaveFailure } from "@/lib/save-failure"

const KEY = draftKey({
  workspaceId: "ws-1",
  userId: "user-1",
  kind: "recipe",
  id: "rec-1",
})

const CONFLICT: SaveFailure = {
  kind: "conflict",
  message: "This recipe changed in another window. Reload to see the latest.",
  version: 4,
}

type Props = {
  snapshot: string
  wholeForm?: boolean
  recordId?: string | null
}

function documentSave(
  save: (expected: number | null) => Promise<SaveEcho | SaveFailure>,
  props: Props = { snapshot: "one" }
) {
  const setDirty = vi.fn()
  const setSaveState = vi.fn()
  const payload = vi.fn(() => ({ title: "Focaccia" }))
  const view = renderHook(
    (current: Props) =>
      useDocumentSave({
        snapshot: current.snapshot,
        active: false,
        wholeForm: current.wholeForm ?? true,
        kind: "recipe",
        workspaceId: "ws-1",
        userId: "user-1",
        recordId: current.recordId === undefined ? "rec-1" : current.recordId,
        editVersion: 3,
        payload,
        setDirty,
        setSaveState,
        save,
      }),
    { initialProps: props }
  )
  return { ...view, setDirty, setSaveState, payload }
}

/** A save that only finishes when the test says so. */
function held() {
  let finish: ((result: SaveEcho | SaveFailure) => void) | null = null
  const save = vi.fn(
    () =>
      new Promise<SaveEcho | SaveFailure>((resolve) => {
        finish = resolve
      })
  )
  return { save, finish: (result: SaveEcho | SaveFailure) => finish?.(result) }
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, "", "/recipes/new")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("the snapshot a save covers", () => {
  it("advances the baseline to what was sent, not to what is on screen", async () => {
    const { save, finish } = held()
    const { result, rerender, setDirty } = documentSave(save)

    await act(async () => {
      void result.current.saveNow()
    })
    rerender({ snapshot: "two" })
    await act(async () => finish({}))

    // "two" was typed while "one" was in flight, so it is still unsaved.
    expect(setDirty).toHaveBeenLastCalledWith(true)
  })

  it("keeps the baseline where it was while a pair is half typed", async () => {
    const save = vi.fn(async () => ({}))
    const { result, rerender, setDirty } = documentSave(save, {
      snapshot: "one",
      wholeForm: false,
    })

    rerender({ snapshot: "two", wholeForm: false })
    await act(async () => {
      await result.current.saveNow()
    })
    expect(setDirty).toHaveBeenLastCalledWith(true)

    // The same save with the form whole does advance it.
    rerender({ snapshot: "two", wholeForm: true })
    await act(async () => {
      await result.current.saveNow()
    })
    expect(setDirty).toHaveBeenLastCalledWith(false)
  })
})

describe("what the server sends back", () => {
  it("adopts the echo when nothing was typed during the save", async () => {
    const adopt = vi.fn()
    const { save, finish } = held()
    const { result } = documentSave(save)

    await act(async () => {
      void result.current.saveNow()
    })
    await act(async () => finish({ adopt }))

    expect(adopt).toHaveBeenCalledTimes(1)
  })

  it("drops the echo when the form moved on", async () => {
    const adopt = vi.fn()
    const { save, finish } = held()
    const { result, rerender } = documentSave(save)

    await act(async () => {
      void result.current.saveNow()
    })
    rerender({ snapshot: "two" })
    await act(async () => finish({ adopt }))

    expect(adopt).not.toHaveBeenCalled()
  })

  it("sends the version it was told, then the one the echo answered with", async () => {
    const echo: (expected: number | null) => Promise<SaveEcho> = async () => ({
      editVersion: 9,
    })
    const save = vi.fn(echo)
    const { result } = documentSave(save)

    await act(async () => {
      await result.current.saveNow()
    })
    await act(async () => {
      await result.current.saveNow()
    })

    expect(save.mock.calls.map((call) => call[0])).toEqual([3, 9])
  })
})

describe("the pill", () => {
  it("says it is saving, then that it saved", async () => {
    const { save, finish } = held()
    const { result, setSaveState } = documentSave(save)

    await act(async () => {
      void result.current.saveNow()
    })
    expect(setSaveState).toHaveBeenLastCalledWith("saving")

    await act(async () => finish({}))
    expect(setSaveState).toHaveBeenLastCalledWith("saved")
  })

  it("reads Not saved after a request failure", async () => {
    const save = vi.fn(async () => ({
      kind: "request" as const,
      message: "Backend is down",
    }))
    const { result, setSaveState } = documentSave(save)

    await act(async () => {
      await result.current.saveNow()
    })

    expect(setSaveState).toHaveBeenLastCalledWith("error")
  })

  it("stays a draft when validation blocked the request", async () => {
    const save = vi.fn(async () => ({
      kind: "validation" as const,
      message: "You can’t edit this recipe",
    }))
    const { result, setSaveState } = documentSave(save)

    await act(async () => {
      await result.current.saveNow()
    })

    expect(setSaveState).toHaveBeenLastCalledWith("saved")
  })

  it("turns a throw into a request failure rather than sticking on Saving…", async () => {
    const save = vi.fn().mockRejectedValue(new Error("Backend is down"))
    const { result, setSaveState } = documentSave(save)

    let failure: SaveFailure | null = null
    await act(async () => {
      failure = await result.current.saveNow()
    })

    expect(failure).toEqual({ kind: "request", message: "Backend is down" })
    expect(setSaveState).toHaveBeenLastCalledWith("error")
  })
})

describe("a write the server refused as stale", () => {
  it("reads Changed elsewhere and stops sending", async () => {
    const save = vi.fn(async () => CONFLICT)
    const { result, rerender, setSaveState } = documentSave(save)

    await act(async () => {
      await result.current.saveNow()
    })
    expect(setSaveState).toHaveBeenLastCalledWith("conflict")
    expect(result.current.conflict).toEqual(CONFLICT)

    rerender({ snapshot: "two" })
    await act(async () => {
      await result.current.saveNow()
    })
    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe("the local recovery copy", () => {
  it("writes while dirty and clears once the save lands", async () => {
    const save = vi.fn(async () => ({}))
    const { result, rerender } = documentSave(save)

    rerender({ snapshot: "two" })
    expect(window.localStorage.getItem(KEY)).not.toBeNull()

    await act(async () => {
      await result.current.saveNow()
    })
    rerender({ snapshot: "two" })
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it("offers a copy that differs from what the server sent", () => {
    writeDraft(KEY, { title: "Focaccia Genovese" })
    const { result } = documentSave(vi.fn(async () => ({})))

    expect(result.current.restorable).toEqual({ title: "Focaccia Genovese" })
  })

  it("keeps the copy on disk while the banner is still offering it", () => {
    writeDraft(KEY, { title: "Focaccia Genovese" })
    const { result, rerender } = documentSave(vi.fn(async () => ({})))

    rerender({ snapshot: "one" })

    expect(result.current.restorable).toEqual({ title: "Focaccia Genovese" })
    expect(window.localStorage.getItem(KEY)).not.toBeNull()
  })

  it("says nothing when the copy matches what is on screen", () => {
    writeDraft(KEY, { title: "Focaccia" })
    const { result } = documentSave(vi.fn(async () => ({})))

    expect(result.current.restorable).toBeNull()
  })

  it("drops the copy on discard", () => {
    writeDraft(KEY, { title: "Focaccia Genovese" })
    const { result } = documentSave(vi.fn(async () => ({})))

    act(() => result.current.discardDraft())

    expect(result.current.restorable).toBeNull()
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it("gives a new record a slot of its own and puts it in the URL", () => {
    const { rerender } = documentSave(
      vi.fn(async () => ({})),
      {
        snapshot: "one",
        recordId: null,
      }
    )

    rerender({ snapshot: "two", recordId: null })

    const uuid = new URLSearchParams(window.location.search).get("draft")
    expect(uuid).not.toBeNull()
    expect(
      window.localStorage.getItem(
        draftKey({
          workspaceId: "ws-1",
          userId: "user-1",
          kind: "recipe",
          id: `new:${uuid}`,
        })
      )
    ).not.toBeNull()
  })

  it("moves the slot to the saved id and clears the one it left", () => {
    const { rerender } = documentSave(
      vi.fn(async () => ({})),
      {
        snapshot: "one",
        recordId: null,
      }
    )
    rerender({ snapshot: "two", recordId: null })
    const uuid = new URLSearchParams(window.location.search).get("draft")
    const newKey = draftKey({
      workspaceId: "ws-1",
      userId: "user-1",
      kind: "recipe",
      id: `new:${uuid}`,
    })

    rerender({ snapshot: "two", recordId: "rec-1" })

    expect(window.localStorage.getItem(newKey)).toBeNull()
  })
})
