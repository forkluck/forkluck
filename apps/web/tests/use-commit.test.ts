// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

import { useCommit, type Commit } from "@/hooks/use-commit"

type Result = { ok: true; editVersion?: number | null } | { error: string }

/** A write the test finishes by hand, so two can be in flight at once. */
function held() {
  const answers: ((result: Result) => void)[] = []
  const write = vi.fn(
    () => new Promise<Result>((resolve) => answers.push(resolve))
  )
  return {
    write,
    answer: async (result: Result, index = 0) => {
      await act(async () => {
        answers[index]?.(result)
      })
    },
  }
}

const DOMAIN = "ingredient:1:allergens"

/** Commits one value to one domain, tracking what apply and revert leave. */
function putter(
  commit: ReturnType<typeof useCommit>,
  shown: { value: string }
) {
  return (value: string, write: Commit["write"]) => {
    const previous = shown.value
    return commit({
      domain: DOMAIN,
      apply: () => {
        shown.value = value
      },
      revert: () => {
        shown.value = previous
      },
      write,
    })
  }
}

afterEach(cleanup)

describe("useCommit", () => {
  it("sends one write at a time and coalesces to the latest value", async () => {
    const first = held()
    const second = held()
    const third = held()
    const shown = { value: "start" }
    const { result } = renderHook(() => useCommit({}))
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
      void put("b", second.write)
      void put("c", third.write)
    })
    // Only the first is on its way; the screen already shows the latest.
    expect(first.write).toHaveBeenCalledTimes(1)
    expect(second.write).not.toHaveBeenCalled()
    expect(shown.value).toBe("c")

    await first.answer({ ok: true })
    // The queue drains to the latest value, never to the one in between.
    expect(second.write).not.toHaveBeenCalled()
    expect(third.write).toHaveBeenCalledTimes(1)

    await third.answer({ ok: true })
    expect(shown.value).toBe("c")
  })

  it("runs two domains at the same time", async () => {
    const one = held()
    const two = held()
    const { result } = renderHook(() => useCommit({}))
    const entry = (domain: string, write: Commit["write"]): Commit => ({
      domain,
      apply: () => {},
      revert: () => {},
      write,
    })

    act(() => {
      void result.current(entry("ingredient:1:allergens", one.write))
      void result.current(entry("ingredient:1:conversion", two.write))
    })
    expect(one.write).toHaveBeenCalledTimes(1)
    expect(two.write).toHaveBeenCalledTimes(1)
    await one.answer({ ok: true })
    await two.answer({ ok: true })
  })

  it("puts the confirmed value back when the last attempt fails", async () => {
    const first = held()
    const shown = { value: "start" }
    const { result } = renderHook(() => useCommit({}))
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
    })
    await first.answer({ error: "Backend is down" })
    expect(shown.value).toBe("start")
  })

  it("keeps the newer value on screen when an older attempt fails", async () => {
    const first = held()
    const second = held()
    const shown = { value: "start" }
    const { result } = renderHook(() => useCommit({}))
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
      void put("b", second.write)
    })
    await first.answer({ error: "Backend is down" })
    // "b" is already on its way; the failed attempt does not undo it.
    expect(shown.value).toBe("b")
    await second.answer({ ok: true })
    expect(shown.value).toBe("b")
  })

  it("reverts to what the server confirmed when both attempts fail", async () => {
    const first = held()
    const second = held()
    const shown = { value: "start" }
    const { result } = renderHook(() => useCommit({}))
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
      void put("b", second.write)
    })
    await first.answer({ error: "Backend is down" })
    await second.answer({ error: "Backend is down" })
    // Not "a": that value was never acknowledged either.
    expect(shown.value).toBe("start")
  })

  it("puts every field of the domain back, not only the one that failed", async () => {
    const first = held()
    const second = held()
    const shown = { one: false, two: false }
    const { result } = renderHook(() => useCommit({}))
    // Two fields, one domain: every revert restores the pair.
    const put = (patch: Partial<typeof shown>, write: Commit["write"]) => {
      const previous = { ...shown }
      return result.current({
        domain: DOMAIN,
        apply: () => Object.assign(shown, patch),
        revert: () => Object.assign(shown, previous),
        write,
      })
    }

    act(() => {
      void put({ one: true }, first.write)
      void put({ two: true }, second.write)
    })
    await first.answer({ error: "Backend is down" })
    await second.answer({ error: "Backend is down" })
    expect(shown).toEqual({ one: false, two: false })
  })

  it("reverts to the value the last success confirmed", async () => {
    const first = held()
    const second = held()
    const shown = { value: "start" }
    const { result } = renderHook(() => useCommit({}))
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
    })
    await first.answer({ ok: true })
    act(() => {
      void put("b", second.write)
    })
    await second.answer({ error: "Backend is down" })
    expect(shown.value).toBe("a")
  })

  it("keeps the confirmed value when a queued attempt fails after a success", async () => {
    const first = held()
    const second = held()
    const shown = { value: "start" }
    const { result } = renderHook(() => useCommit({}))
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
      void put("b", second.write)
    })
    await first.answer({ ok: true })
    await second.answer({ error: "Backend is down" })
    // "a" is what the server holds; "b" never landed.
    expect(shown.value).toBe("a")
  })

  it("keeps the confirmed value when a coalesced attempt fails after a success", async () => {
    const first = held()
    const third = held()
    const shown = { value: "start" }
    const { result } = renderHook(() => useCommit({}))
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
      void put("b", vi.fn())
      void put("c", third.write)
    })
    await first.answer({ ok: true })
    await third.answer({ error: "Backend is down" })
    // Not "b": only "a" was ever sent and acknowledged.
    expect(shown.value).toBe("a")
  })

  it("still reverts after a remount", async () => {
    const first = held()
    const shown = { value: "start" }
    const { result } = renderHook(() => useCommit({}), {
      wrapper: React.StrictMode,
    })
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
    })
    await first.answer({ error: "Backend is down" })
    expect(shown.value).toBe("start")
  })

  it("answers every caller waiting on the domain", async () => {
    const first = held()
    const second = held()
    const { result } = renderHook(() => useCommit({}))
    const shown = { value: "start" }
    const put = putter(result.current, shown)
    const answers: (string | null)[] = []
    const record = (promise: Promise<{ message: string } | null>) =>
      void promise.then((failure) => answers.push(failure?.message ?? null))

    act(() => {
      record(put("a", first.write))
      record(put("b", second.write))
    })
    await first.answer({ error: "Backend is down" })
    expect(answers).toEqual(["Backend is down"])
    await second.answer({ ok: true })
    expect(answers).toEqual(["Backend is down", null])
  })

  it("reports saving, then error until a later success", async () => {
    const first = held()
    const second = held()
    const onSaveState = vi.fn()
    const { result } = renderHook(() => useCommit({ onSaveState }))
    const shown = { value: "start" }
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
    })
    expect(onSaveState).toHaveBeenLastCalledWith("saving")
    await first.answer({ error: "Backend is down" })
    expect(onSaveState).toHaveBeenLastCalledWith("error")

    act(() => {
      void put("b", second.write)
    })
    await second.answer({ ok: true })
    expect(onSaveState).toHaveBeenLastCalledWith("saved")
  })

  it("waits for every domain before it says saved", async () => {
    const one = held()
    const two = held()
    const onSaveState = vi.fn()
    const { result } = renderHook(() => useCommit({ onSaveState }))
    const entry = (domain: string, write: Commit["write"]): Commit => ({
      domain,
      apply: () => {},
      revert: () => {},
      write,
    })

    act(() => {
      void result.current(entry("ingredient:1:allergens", one.write))
      void result.current(entry("ingredient:1:conversion", two.write))
    })
    await one.answer({ ok: true })
    expect(onSaveState).toHaveBeenLastCalledWith("saving")
    await two.answer({ ok: true })
    expect(onSaveState).toHaveBeenLastCalledWith("saved")
  })

  it("adopts the version a write echoed", async () => {
    const first = held()
    const onVersion = vi.fn()
    const onSaved = vi.fn()
    const { result } = renderHook(() => useCommit({ onVersion, onSaved }))
    const shown = { value: "start" }
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
    })
    await first.answer({ ok: true, editVersion: 7 })
    expect(onVersion).toHaveBeenCalledWith(7)
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it("says nothing once the screen is gone", async () => {
    const first = held()
    const onSaveState = vi.fn()
    const onSaved = vi.fn()
    const shown = { value: "start" }
    const { result, unmount } = renderHook(() =>
      useCommit({ onSaveState, onSaved })
    )
    const put = putter(result.current, shown)

    act(() => {
      void put("a", first.write)
    })
    unmount()
    await first.answer({ error: "Backend is down" })
    expect(shown.value).toBe("a")
    expect(onSaved).not.toHaveBeenCalled()
    expect(onSaveState).not.toHaveBeenLastCalledWith("error")
  })

  it("turns a thrown write into a failure", async () => {
    const { result } = renderHook(() => useCommit({}))
    const shown = { value: "start" }
    const put = putter(result.current, shown)
    let message: string | null = null

    await act(async () => {
      const failure = await put("a", () => {
        throw new Error("Failed to find the Server Action")
      })
      message = failure?.message ?? null
    })
    expect(message).toContain("A new version was deployed")
    expect(shown.value).toBe("start")
  })
})
