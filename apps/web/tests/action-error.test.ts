import { beforeEach, describe, expect, it, vi } from "vitest"

// `server-only` has no runtime entry outside the Next.js bundler.
vi.mock("server-only", () => ({}))
const redirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`)
})
vi.mock("next/navigation", () => ({ redirect }))

const { BackendRequestError, BackendUnauthorizedError } =
  await import("@/lib/backend/client")
const { actionErrorMessage } = await import("@/lib/backend/action-error")

describe("actionErrorMessage", () => {
  beforeEach(() => {
    redirect.mockClear()
  })

  it("sends an expired session to the login page instead of returning copy", () => {
    expect(() =>
      actionErrorMessage(new BackendUnauthorizedError("no session"), "fallback")
    ).toThrow("NEXT_REDIRECT:/login")
    expect(redirect).toHaveBeenCalledWith("/login")
  })

  it("returns a refused write on a read-only account as ordinary copy", () => {
    const refused = new BackendRequestError(
      "Your trial has ended. Subscribe to keep editing.",
      403,
      "subscription_required"
    )
    expect(actionErrorMessage(refused, "Couldn’t save.")).toBe(
      "Your trial has ended. Subscribe to keep editing."
    )
    expect(redirect).not.toHaveBeenCalled()
  })

  it("keeps the backend's own sentence, and falls back otherwise", () => {
    expect(
      actionErrorMessage(
        new BackendRequestError("That currency doesn’t match.", 400),
        "Couldn’t save that rate."
      )
    ).toBe("That currency doesn’t match.")
    expect(actionErrorMessage("nope", "Couldn’t save that rate.")).toBe(
      "Couldn’t save that rate."
    )
  })
})
