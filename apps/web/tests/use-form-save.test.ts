// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import type { SaveFailure } from "@/lib/save-failure"

const CONFLICT: SaveFailure = {
  kind: "conflict",
  message: "This ingredient changed in another window.",
  version: 4,
}
const REFUSED: SaveFailure = { kind: "request", message: "Backend is down" }

type Props = { snapshot: string; saved?: boolean }

function formSave(
  save: () => Promise<SaveFailure | null>,
  validate?: () => FormErrors,
  initialProps: Props = { snapshot: "one" }
) {
  return renderHook(
    (props: Props) =>
      useFormSave({
        snapshot: props.snapshot,
        saved: props.saved,
        validate,
        save,
      }),
    { initialProps }
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

describe("validation", () => {
  it("blocks the request, shows the message and focuses the field", async () => {
    const field = document.createElement("input")
    field.id = "name"
    document.body.append(field)
    const save = vi.fn(async () => null)
    const { result, rerender } = formSave(save, () => ({
      name: "Enter a name.",
    }))

    rerender({ snapshot: "two" })
    await act(async () => {
      expect(await result.current.submit()).toBe(false)
    })

    expect(save).not.toHaveBeenCalled()
    expect(result.current.errors).toEqual({ name: "Enter a name." })
    expect(document.activeElement).toBe(field)
    // A form that failed validation is still a draft, not a failed save.
    expect(result.current.saveState).toBe("saved")
    expect(result.current.dirty).toBe(true)
    field.remove()
  })

  it("drops the message as soon as the form moves", async () => {
    const { result, rerender } = formSave(
      async () => null,
      () => ({ name: "Enter a name." })
    )

    await act(async () => {
      await result.current.submit()
    })
    expect(result.current.errors).toEqual({ name: "Enter a name." })

    rerender({ snapshot: "two" })
    expect(result.current.errors).toEqual({})
  })
})

describe("what reaches the server", () => {
  it("sends nothing when nothing changed", async () => {
    const save = vi.fn(async () => null)
    const { result } = formSave(save)

    await act(async () => {
      expect(await result.current.submit()).toBe(true)
    })

    expect(save).not.toHaveBeenCalled()
    expect(result.current.dirty).toBe(false)
  })

  it("sends every submit of a form that is never clean", async () => {
    const save = vi.fn(async () => null)
    const { result } = formSave(save, undefined, {
      snapshot: "one",
      saved: false,
    })

    // The first press sends even though nothing was typed: there is no
    // baseline for it to match.
    await act(async () => {
      expect(await result.current.submit()).toBe(true)
    })
    await act(async () => {
      expect(await result.current.submit()).toBe(true)
    })

    expect(save).toHaveBeenCalledTimes(2)
  })

  it("holds a never-saved form clean until it moves", async () => {
    const save = vi.fn(async () => null)
    const { result, rerender } = formSave(save, undefined, {
      snapshot: "one",
      saved: false,
    })

    expect(result.current.dirty).toBe(false)

    rerender({ snapshot: "two", saved: false })
    expect(result.current.dirty).toBe(true)

    rerender({ snapshot: "one", saved: false })
    expect(result.current.dirty).toBe(false)
  })

  it("rejects a second submit while the first is running", async () => {
    const { save, finish } = held()
    const { result, rerender } = formSave(save)
    rerender({ snapshot: "two" })

    let second: boolean | null = null
    await act(async () => {
      void result.current.submit()
      second = await result.current.submit()
    })

    expect(second).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(true)

    await act(async () => finish(null))
    expect(result.current.pending).toBe(false)
  })

  it("keeps an edit made while the save was in flight", async () => {
    const { save, finish } = held()
    const { result, rerender } = formSave(save)
    rerender({ snapshot: "two" })

    await act(async () => {
      void result.current.submit()
    })
    rerender({ snapshot: "three" })
    await act(async () => finish(null))

    // The baseline only advanced to what was sent.
    expect(result.current.dirty).toBe(true)
  })
})

describe("a save that did not land", () => {
  it("keeps the form dirty and says so", async () => {
    const save = vi.fn(async () => REFUSED)
    const { result, rerender } = formSave(save)
    rerender({ snapshot: "two" })

    await act(async () => {
      expect(await result.current.submit()).toBe(false)
    })

    expect(result.current.saveState).toBe("error")
    expect(result.current.failure).toEqual(REFUSED)
    expect(result.current.dirty).toBe(true)
  })

  it("keeps a conflict as its own state", async () => {
    const save = vi.fn(async () => CONFLICT)
    const { result, rerender } = formSave(save)
    rerender({ snapshot: "two" })

    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.saveState).toBe("conflict")
    expect(result.current.failure).toEqual(CONFLICT)
  })

  it("turns a thrown error into a request failure", async () => {
    const save = vi.fn(async () => {
      throw new Error("Network down")
    })
    const { result, rerender } = formSave(save)
    rerender({ snapshot: "two" })

    await act(async () => {
      expect(await result.current.submit()).toBe(false)
    })

    expect(result.current.failure).toEqual({
      kind: "request",
      message: "Network down",
    })
    expect(result.current.pending).toBe(false)
  })

  it("clears the message on the retry that lands", async () => {
    const save = vi
      .fn<() => Promise<SaveFailure | null>>()
      .mockResolvedValueOnce(REFUSED)
      .mockResolvedValueOnce(null)
    const { result, rerender } = formSave(save)
    rerender({ snapshot: "two" })

    await act(async () => {
      await result.current.submit()
    })
    await act(async () => {
      expect(await result.current.submit()).toBe(true)
    })

    expect(result.current.failure).toBeNull()
    expect(result.current.saveState).toBe("saved")
    expect(result.current.dirty).toBe(false)
  })
})
