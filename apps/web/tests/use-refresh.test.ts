// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const refresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { useRefresh } from "@/hooks/use-refresh"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("useRefresh", () => {
  it("calls the router inside a transition and resolves when it settles", async () => {
    const { result } = renderHook(() => useRefresh())
    expect(result.current.pending).toBe(false)

    let settled = false
    let done: Promise<void> = Promise.resolve()
    // Started inside act so the transition's renders flush; awaited outside
    // it, because the promise settles on one of those renders.
    act(() => {
      done = result.current.refresh().then(() => {
        settled = true
      })
    })
    expect(refresh).toHaveBeenCalledOnce()
    await done
    expect(settled).toBe(true)
    expect(result.current.pending).toBe(false)
  })

  it("answers a caller whose screen unmounts before the refresh lands", async () => {
    const { result, unmount } = renderHook(() => useRefresh())
    let settled = false
    const done = result.current.refresh().then(() => {
      settled = true
    })
    unmount()
    await done
    expect(settled).toBe(true)
  })
})
