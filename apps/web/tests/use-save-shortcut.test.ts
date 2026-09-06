// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

import { useSaveShortcut } from "@/hooks/use-save-shortcut"

afterEach(cleanup)

function press(key = "s", init: KeyboardEventInit = { metaKey: true }) {
  const event = new KeyboardEvent("keydown", {
    key,
    cancelable: true,
    ...init,
  })
  window.dispatchEvent(event)
  return event
}

function focusedField() {
  const field = document.createElement("input")
  document.body.append(field)
  field.focus()
  return field
}

describe("useSaveShortcut", () => {
  it("commits the focused field before it saves", async () => {
    const field = focusedField()
    const focusedWhenSaved: (Element | null)[] = []
    const save = vi.fn(() => {
      focusedWhenSaved.push(document.activeElement)
      return Promise.resolve()
    })
    renderHook(() => useSaveShortcut(save))

    await act(async () => {
      press()
    })

    expect(save).toHaveBeenCalledTimes(1)
    expect(focusedWhenSaved).toEqual([document.body])
    field.remove()
  })

  it("keeps the browser's own Save dialog away", async () => {
    renderHook(() => useSaveShortcut(vi.fn()))

    let event!: KeyboardEvent
    await act(async () => {
      event = press()
    })

    expect(event.defaultPrevented).toBe(true)
  })

  it("saves on Ctrl+S too, and on nothing else", async () => {
    const save = vi.fn()
    renderHook(() => useSaveShortcut(save))

    await act(async () => {
      press("s", { ctrlKey: true })
    })
    expect(save).toHaveBeenCalledTimes(1)

    const plain = press("s", {})
    const other = press("d", { metaKey: true })
    expect(save).toHaveBeenCalledTimes(1)
    expect(plain.defaultPrevented).toBe(false)
    expect(other.defaultPrevented).toBe(false)
  })

  it("stops listening once the screen is gone", async () => {
    const save = vi.fn()
    const { unmount } = renderHook(() => useSaveShortcut(save))

    unmount()
    await act(async () => {
      press()
    })

    expect(save).not.toHaveBeenCalled()
  })
})
