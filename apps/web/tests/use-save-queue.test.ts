// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

import { useSaveQueue } from "@/hooks/use-save-queue"
import type { SaveFailure } from "@/lib/save-failure"

type Save = () => Promise<SaveFailure | null>

const CONFLICT: SaveFailure = {
  kind: "conflict",
  message: "This recipe changed in another window. Reload to see the latest.",
  version: 3,
}
const REFUSED: SaveFailure = { kind: "request", message: "Backend is down" }

function queue(save: Save, snapshot = "one") {
  return renderHook<ReturnType<typeof useSaveQueue>, { snapshot: string }>(
    (props) => useSaveQueue({ snapshot: props.snapshot, save }),
    { initialProps: { snapshot } }
  )
}

/** A save that only finishes when the test says so. */
function held() {
  let finish: ((failure: SaveFailure | null) => void) | null = null
  const save = vi.fn(
    () =>
      new Promise<SaveFailure | null>((resolve) => {
        finish = resolve
      })
  )
  return { save, finish: (failure: SaveFailure | null) => finish?.(failure) }
}

afterEach(cleanup)

describe("one save at a time", () => {
  it("lets a second ask for the same snapshot ride along", async () => {
    const { save, finish } = held()
    const { result } = queue(save)

    await act(async () => {
      void result.current()
      void result.current()
    })
    expect(save).toHaveBeenCalledTimes(1)

    await act(async () => finish(null))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("follows the running save with one more when the snapshot moved on", async () => {
    const { save, finish } = held()
    const { result, rerender } = queue(save)

    await act(async () => {
      void result.current()
    })
    rerender({ snapshot: "two" })
    await act(async () => {
      void result.current()
    })
    expect(save).toHaveBeenCalledTimes(1)

    await act(async () => finish(null))
    expect(save).toHaveBeenCalledTimes(2)
  })
})

describe("a save that did not land", () => {
  it("turns a throw into a request failure rather than hanging", async () => {
    const save = vi.fn().mockRejectedValue(new Error("Backend is down"))
    const { result } = queue(save)

    let failure: SaveFailure | null = null
    await act(async () => {
      failure = await result.current()
    })

    expect(failure).toEqual(REFUSED)
  })

  it("still drains a newer snapshot after a request failure", async () => {
    const { save, finish } = held()
    const { result, rerender } = queue(save)

    await act(async () => {
      void result.current()
    })
    rerender({ snapshot: "two" })
    await act(async () => {
      void result.current()
    })
    await act(async () => finish(REFUSED))

    expect(save).toHaveBeenCalledTimes(2)
  })

  it("stops sending after a conflict, and answers every ask with it", async () => {
    const { save, finish } = held()
    const { result, rerender } = queue(save)

    await act(async () => {
      void result.current()
    })
    rerender({ snapshot: "two" })
    await act(async () => {
      void result.current()
    })
    await act(async () => finish(CONFLICT))
    expect(save).toHaveBeenCalledTimes(1)

    rerender({ snapshot: "three" })
    let failure: SaveFailure | null = null
    await act(async () => {
      failure = await result.current()
    })
    expect(failure).toEqual(CONFLICT)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
