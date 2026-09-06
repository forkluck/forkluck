// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

import { useEditChrome } from "@/hooks/use-edit-chrome"

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function pressSave() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true })
  )
}

describe("the chrome's Save", () => {
  it("saves the screen", async () => {
    const save = vi.fn(() => Promise.resolve())
    const { result } = renderHook(() => useEditChrome())
    act(() => {
      result.current.saveRef.current = save
    })

    await act(async () => pressSave())

    expect(save).toHaveBeenCalledTimes(1)
  })

  it("drops a second press while the first save is in flight", async () => {
    let finish: (() => void) | null = null
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const { result } = renderHook(() => useEditChrome())
    act(() => {
      result.current.saveRef.current = save
    })

    await act(async () => pressSave())
    await act(async () => pressSave())
    expect(save).toHaveBeenCalledTimes(1)

    await act(async () => finish?.())
    await act(async () => pressSave())
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("reads Saved for a moment after a press, then Save again", async () => {
    const { result } = renderHook(() => useEditChrome())
    act(() => {
      result.current.saveRef.current = () => Promise.resolve()
    })
    expect(result.current.saveLabel).toBe("Save")

    await act(async () => pressSave())
    expect(result.current.saveLabel).toBe("Saved")

    await act(async () => vi.advanceTimersByTime(2499))
    expect(result.current.saveLabel).toBe("Saved")
    await act(async () => vi.advanceTimersByTime(1))
    expect(result.current.saveLabel).toBe("Save")
  })

  it("reads Retry after a refusal, and Save again once the cook types", async () => {
    const { result } = renderHook(() => useEditChrome())
    act(() => {
      result.current.saveRef.current = async () => {
        result.current.setSaveState("error")
      }
    })

    await act(async () => pressSave())
    expect(result.current.saveLabel).toBe("Retry")

    act(() => result.current.setDirty(true))
    expect(result.current.saveLabel).toBe("Save")
  })

  it("keeps reading Save when validation left a draft behind", async () => {
    const { result } = renderHook(() => useEditChrome())
    act(() => {
      result.current.setDirty(true)
      result.current.saveRef.current = () => Promise.resolve()
    })

    await act(async () => pressSave())
    expect(result.current.saveLabel).toBe("Save")
  })
})
