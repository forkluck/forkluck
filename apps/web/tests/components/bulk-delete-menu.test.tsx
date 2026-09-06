// @vitest-environment jsdom

import * as React from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const refresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { BulkDeleteMenu } from "@/components/ui/bulk-delete-menu"
import { ToastProvider } from "@/components/ui/toast"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function mount(onDelete: () => Promise<void | boolean>) {
  render(
    <ToastProvider>
      <BulkDeleteMenu
        count={2}
        noun="recipe"
        description="They are removed."
        onDelete={onDelete}
      />
    </ToastProvider>
  )
}

async function openConfirm() {
  fireEvent.click(screen.getByRole("button", { name: "Selection actions" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }))
  return screen.findByRole("button", { name: /Delete recipes|Deleting/ })
}

describe("BulkDeleteMenu", () => {
  it("stays busy through the refresh and closes once it has landed", async () => {
    let finish: () => void = () => undefined
    const onDelete = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    mount(onDelete)
    const confirm = await openConfirm()
    fireEvent.click(confirm)

    // The action is in flight: the confirm spins and refuses a second press.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Deleting/ })).toHaveProperty(
        "disabled",
        true
      )
    )
    expect(refresh).not.toHaveBeenCalled()

    await act(async () => finish())
    // The refresh went out inside a transition, and only after it settled did
    // the dialog leave.
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Deleting/ })).toBeNull()
    )
    expect(screen.queryByText("Delete 2 recipes?")).toBeNull()
  })

  it("reports a batch that threw instead of swallowing it", async () => {
    mount(() => Promise.reject(new Error("Croissant is on a menu.")))
    const confirm = await openConfirm()
    fireEvent.click(confirm)

    expect(await screen.findByText("Croissant is on a menu.")).toBeTruthy()
    expect(refresh).not.toHaveBeenCalled()
    // The confirmation stays, so the rest of the selection can be retried.
    expect(screen.getByText("Delete 2 recipes?")).toBeTruthy()
  })
})
