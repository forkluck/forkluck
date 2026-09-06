// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

import { useAutosave } from "@/hooks/use-autosave"
import type { SaveFailure } from "@/lib/save-failure"

type Props = { snapshot: string; active: boolean; immediate?: boolean }
type Save = () => Promise<SaveFailure | null>

const FAILED: SaveFailure = { kind: "request", message: "Backend is down" }

function autosave(save: Save, initial?: Partial<Props>) {
  return renderHook<Save, Props>((props) => useAutosave({ ...props, save }), {
    initialProps: { snapshot: "one", active: false, ...initial },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("saving a form that keeps changing", () => {
  it("waits three seconds after the last change", async () => {
    const save = vi.fn().mockResolvedValue(null)
    const { rerender } = autosave(save)

    rerender({ snapshot: "two", active: true })
    await act(async () => {
      vi.advanceTimersByTime(2999)
    })
    expect(save).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("starts the three seconds again on every change", async () => {
    const save = vi.fn().mockResolvedValue(null)
    const { rerender } = autosave(save)

    rerender({ snapshot: "two", active: true })
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    rerender({ snapshot: "three", active: true })
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(save).not.toHaveBeenCalled()
  })

  it("saves once a minute while the changes keep coming", async () => {
    const save = vi.fn().mockResolvedValue(null)
    const { rerender } = autosave(save)

    rerender({ snapshot: "change-0", active: true })
    for (let second = 1; second <= 60; second += 1) {
      rerender({ snapshot: `change-${second}`, active: true })
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
    }

    expect(save).toHaveBeenCalledTimes(1)
  })

  it("follows a save with exactly one more when a change lands during it", async () => {
    let finishFirst: ((failure: SaveFailure | null) => void) | null = null
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SaveFailure | null>((resolve) => {
            finishFirst = resolve
          })
      )
      .mockResolvedValue(null)
    const { rerender } = autosave(save)

    rerender({ snapshot: "two", active: true })
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(save).toHaveBeenCalledTimes(1)

    // Typed while the first save is still in the air.
    rerender({ snapshot: "three", active: true })
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(save).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishFirst?.(null)
    })
    expect(save).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(10000)
    })
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("saves at once when the caller says not to wait", async () => {
    const save = vi.fn().mockResolvedValue(null)
    const { rerender } = autosave(save)

    rerender({ snapshot: "two", active: true, immediate: true })
    await act(async () => {})

    expect(save).toHaveBeenCalledTimes(1)
  })

  it("saves nothing while there is nothing worth saving", async () => {
    const save = vi.fn().mockResolvedValue(null)
    const { rerender } = autosave(save)

    rerender({ snapshot: "two", active: false })
    await act(async () => {
      vi.advanceTimersByTime(120000)
    })

    expect(save).not.toHaveBeenCalled()
  })

  it("resolves the caller's own save with what the last one did", async () => {
    const save = vi.fn().mockResolvedValue(FAILED)
    const { result } = autosave(save)

    let landed: SaveFailure | null = null
    await act(async () => {
      landed = await result.current()
    })

    expect(landed).toEqual(FAILED)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
