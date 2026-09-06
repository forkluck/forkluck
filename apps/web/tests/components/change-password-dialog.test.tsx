// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const changePassword = vi.hoisted(() => vi.fn())
const toastAdd = vi.hoisted(() => vi.fn())

vi.mock("@/lib/auth-client", () => ({
  authClient: { changePassword },
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

import { ChangePasswordDialog } from "@/components/settings/change-password-dialog"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function open(onOpenChange = vi.fn()) {
  render(<ChangePasswordDialog open onOpenChange={onOpenChange} />)
  return onOpenChange
}

function fillValid() {
  type("Current password", "current-password-1234")
  type("New password", "new-password-5678")
  type("Confirm new password", "new-password-5678")
}

describe("ChangePasswordDialog", () => {
  it("validates all three fields before sending credentials", () => {
    open()
    fireEvent.click(screen.getByRole("button", { name: "Change password" }))
    expect(changePassword).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter your current password."
    )

    type("Current password", "current-password-1234")
    type("New password", "new-password-5678")
    type("Confirm new password", "different-password")
    fireEvent.click(screen.getByRole("button", { name: "Change password" }))
    expect(changePassword).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "The new passwords don’t match."
    )
  })

  it("closes and confirms only after the password changed", async () => {
    changePassword.mockResolvedValue({})
    const onOpenChange = open()
    fillValid()

    fireEvent.click(screen.getByRole("button", { name: "Change password" }))

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith({
        currentPassword: "current-password-1234",
        newPassword: "new-password-5678",
      })
    )
    expect(toastAdd).toHaveBeenCalledWith({ title: "Password changed." })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("stays open on failure and guards a dirty dismissal", async () => {
    changePassword.mockResolvedValue({
      error: { message: "Current password is incorrect" },
    })
    const onOpenChange = open()
    fillValid()

    fireEvent.click(screen.getByRole("button", { name: "Change password" }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Current password is incorrect"
    )
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(await screen.findByText("Discard changes?")).toBeTruthy()
  })
})
