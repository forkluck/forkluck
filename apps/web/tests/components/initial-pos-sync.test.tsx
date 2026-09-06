// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"

const { enqueuePosSync, toastAdd } = vi.hoisted(() => ({
  enqueuePosSync: vi.fn(),
  toastAdd: vi.fn(),
}))

vi.mock("@/app/(app)/sales/actions", () => ({ enqueuePosSync }))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

import { InitialPosSync } from "@/components/settings/initial-pos-sync"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.replaceState(
    {},
    "",
    "/integrations/sales/connections?connected=square"
  )
})

describe("initial POS sync", () => {
  it("shows the enqueue error and still releases the connection screen", async () => {
    enqueuePosSync.mockResolvedValue({ error: "Square is unavailable" })
    const onComplete = vi.fn()

    render(<InitialPosSync provider="square" onComplete={onComplete} />)

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith("square"))
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Couldn’t start the initial sync",
      description: "Square is unavailable",
      type: "error",
    })
    expect(window.location.search).toBe("")
  })
})
