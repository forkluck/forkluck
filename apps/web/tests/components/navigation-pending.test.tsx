// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const { push, replace } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn() }),
}))

import {
  NavigationBlockerProvider,
  useGuardedNavigate,
  useNavigationBlocker,
} from "@/components/navigation-blocker"

/** What the shell reads: is any navigation in flight? */
function Signal() {
  const { navigationPending } = useNavigationBlocker()
  return <output>{navigationPending ? "pending" : "idle"}</output>
}

/** A wait somewhere on the screen, reported for as long as it is mounted. */
function Reporter() {
  const { reportNavigationPending } = useNavigationBlocker()
  React.useEffect(() => {
    reportNavigationPending(1)
    return () => reportNavigationPending(-1)
  }, [reportNavigationPending])
  return null
}

function Screen({
  dirty,
  options,
}: {
  dirty: boolean
  options?: { replace?: boolean; force?: boolean }
}) {
  const { setIsBlocked } = useNavigationBlocker()
  const { go } = useGuardedNavigate()
  React.useEffect(() => setIsBlocked(dirty), [dirty, setIsBlocked])
  return (
    <button type="button" onClick={() => void go("/recipes", options)}>
      Go
    </button>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the shell's navigation signal", () => {
  it("stays up while any reporter is mounted and drops with the last one", async () => {
    function Harness() {
      const [count, setCount] = React.useState(2)
      return (
        <NavigationBlockerProvider>
          <Signal />
          {Array.from({ length: count }, (_, index) => (
            <Reporter key={index} />
          ))}
          <button type="button" onClick={() => setCount((c) => c - 1)}>
            Finish one
          </button>
        </NavigationBlockerProvider>
      )
    }
    render(<Harness />)
    expect(screen.getByRole("status").textContent).toBe("pending")

    fireEvent.click(screen.getByText("Finish one"))
    // The first click's end must not clear the second click's wait.
    expect(screen.getByRole("status").textContent).toBe("pending")

    fireEvent.click(screen.getByText("Finish one"))
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("idle")
    )
  })
})

describe("useGuardedNavigate", () => {
  it("navigates at once when the screen is clean", async () => {
    render(
      <NavigationBlockerProvider>
        <Screen dirty={false} />
      </NavigationBlockerProvider>
    )
    fireEvent.click(screen.getByText("Go"))
    await waitFor(() => expect(push).toHaveBeenCalledWith("/recipes"))
    expect(screen.queryByText("Leave without saving?")).toBeNull()
  })

  it("asks first when the screen holds unsaved work", async () => {
    render(
      <NavigationBlockerProvider>
        <Screen dirty />
      </NavigationBlockerProvider>
    )
    fireEvent.click(screen.getByText("Go"))
    expect(await screen.findByText("Leave without saving?")).toBeTruthy()
    expect(push).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Leave without saving" })
      )
    })
    await waitFor(() => expect(push).toHaveBeenCalledWith("/recipes"))
  })

  it("skips the question for a screen that has just saved, and can replace", async () => {
    render(
      <NavigationBlockerProvider>
        <Screen dirty options={{ force: true, replace: true }} />
      </NavigationBlockerProvider>
    )
    fireEvent.click(screen.getByText("Go"))
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/recipes"))
    expect(push).not.toHaveBeenCalled()
    expect(screen.queryByText("Leave without saving?")).toBeNull()
  })
})
