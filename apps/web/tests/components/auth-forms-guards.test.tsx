// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const signInEmail = vi.hoisted(() => vi.fn())
const signUpEmail = vi.hoisted(() => vi.fn())
const verifyEmail = vi.hoisted(() => vi.fn())
const requestPasswordReset = vi.hoisted(() => vi.fn())
const resetPassword = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: signInEmail },
    signUp: { email: signUpEmail },
    verifyEmail,
    requestPasswordReset,
    resetPassword,
    resendCode: vi.fn(),
  },
}))
vi.mock("next/navigation", () => {
  const router = { push, refresh }
  return { useRouter: () => router }
})

import { LoginForm } from "@/components/auth/login-form"
import { SignupForm } from "@/components/auth/signup-form"
import { VerifyCodeForm } from "@/components/auth/verify-code-form"
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe("login Sign in", () => {
  it("stays enabled while empty and guards before calling the action", () => {
    render(<LoginForm />)
    const button = screen.getByRole("button", { name: "Sign in" })
    expect((button as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(button)
    expect(signInEmail).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Enter your email.")

    type("Email", "cook@example.com")
    fireEvent.click(button)
    expect(signInEmail).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter your password."
    )

    type("Password", "secret123")
    signInEmail.mockResolvedValue({})
    fireEvent.click(button)
    expect(signInEmail).toHaveBeenCalledTimes(1)
  })
})

describe("login return-to", () => {
  it("lands on the invited path instead of the kitchen", async () => {
    render(<LoginForm next="/recipes/abc/recipe" />)
    type("Email", "cook@example.com")
    type("Password", "secret123")
    signInEmail.mockResolvedValue({})

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith("/recipes/abc/recipe")
    )
  })

  it("carries the path across the verification step", async () => {
    render(<LoginForm next="/recipes/abc/recipe" />)
    type("Email", "cook@example.com")
    type("Password", "secret123")
    // The account exists but was never verified, so the code step takes over.
    signInEmail.mockResolvedValue({ pendingVerification: true })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    fireEvent.change(await screen.findByLabelText("Code"), {
      target: { value: "123456" },
    })
    verifyEmail.mockResolvedValue({ data: {} })
    fireEvent.click(screen.getByRole("button", { name: "Verify" }))

    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith("/recipes/abc/recipe")
    )
  })
})

describe("signup Create account", () => {
  it("preserves the destination through account creation and verification", async () => {
    render(<SignupForm next="/recipes/abc/recipe" />)
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href")
    ).toBe("/login?next=%2Frecipes%2Fabc%2Frecipe")
    type("Name", "Cook")
    type("Email", "cook@example.test")
    type("Password", "longenough")
    signUpEmail.mockResolvedValue({ pendingVerification: true })
    fireEvent.click(screen.getByRole("button", { name: "Create account" }))
    fireEvent.change(await screen.findByLabelText("Code"), {
      target: { value: "123456" },
    })
    verifyEmail.mockResolvedValue({ data: {} })
    fireEvent.click(screen.getByRole("button", { name: "Verify" }))
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith("/recipes/abc/recipe")
    )
  })

  it("stays enabled while empty and guards before calling the action", () => {
    render(<SignupForm />)
    const button = screen.getByRole("button", { name: "Create account" })
    expect((button as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(button)
    expect(signUpEmail).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Enter your name.")

    type("Name", "Cook")
    fireEvent.click(button)
    expect(screen.getByRole("alert").textContent).toContain("Enter your email.")

    type("Email", "cook@example.com")
    type("Password", "short")
    fireEvent.click(button)
    expect(signUpEmail).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Use at least 8 characters."
    )

    type("Password", "longenough")
    signUpEmail.mockResolvedValue({})
    fireEvent.click(button)
    expect(signUpEmail).toHaveBeenCalledTimes(1)
  })
})

describe("verify Verify", () => {
  it("stays enabled while empty and guards before calling the action", () => {
    render(<VerifyCodeForm email="cook@example.com" />)
    const button = screen.getByRole("button", { name: "Verify" })
    expect((button as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(button)
    expect(verifyEmail).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter the 6-digit code."
    )

    type("Code", "123456")
    verifyEmail.mockResolvedValue({ data: {} })
    fireEvent.click(button)
    expect(verifyEmail).toHaveBeenCalledTimes(1)
  })
})

describe("forgot-password Send reset code", () => {
  it("stays enabled while empty and guards before calling the action", () => {
    render(<ForgotPasswordForm />)
    const button = screen.getByRole("button", { name: "Send reset code" })
    expect((button as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(button)
    expect(requestPasswordReset).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Enter your email.")

    type("Email", "cook@example.com")
    requestPasswordReset.mockResolvedValue({})
    fireEvent.click(button)
    expect(requestPasswordReset).toHaveBeenCalledTimes(1)
  })
})

describe("forgot-password Reset password", () => {
  it("stays enabled and guards the reset stage before calling the action", async () => {
    render(<ForgotPasswordForm />)
    type("Email", "cook@example.com")
    requestPasswordReset.mockResolvedValue({})
    fireEvent.click(screen.getByRole("button", { name: "Send reset code" }))

    const button = await screen.findByRole("button", { name: "Reset password" })
    expect((button as HTMLButtonElement).disabled).toBe(false)

    type("New password", "longenough")
    fireEvent.click(button)
    expect(resetPassword).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter the 6-digit reset code."
    )

    type("Reset code", "123456")
    type("New password", "short")
    fireEvent.click(button)
    expect(resetPassword).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Use at least 8 characters."
    )

    type("New password", "longenough")
    resetPassword.mockResolvedValue({})
    fireEvent.click(button)
    expect(resetPassword).toHaveBeenCalledTimes(1)
  })
})
