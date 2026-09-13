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
// The widget is Cloudflare's script; the stub records what the form asks of
// it and hands over a token like the real one would.
const widgetProps = vi.hoisted(
  () => [] as Array<{ siteKey: string; resetSignal?: number }>
)
const widgetToken = vi.hoisted(() => ({
  value: "synthetic-token" as string | null,
}))
vi.mock("@/components/auth/turnstile-widget", async () => {
  const React = await import("react")
  return {
    TurnstileWidget: (props: {
      siteKey: string
      onToken: (token: string | null) => void
      resetSignal?: number
    }) => {
      widgetProps.push({
        siteKey: props.siteKey,
        resetSignal: props.resetSignal,
      })
      const { onToken } = props
      React.useEffect(() => {
        if (widgetToken.value) onToken(widgetToken.value)
      }, [onToken])
      return null
    },
  }
})

import {
  readLastSignInMethod,
  writeLastSignInMethod,
} from "@/components/auth/last-sign-in-method"
import { authNoticeCode } from "@/components/auth/auth-notice"
import { LoginForm } from "@/components/auth/login-form"
import { SignupForm } from "@/components/auth/signup-form"
import { VerifyCodeForm } from "@/components/auth/verify-code-form"
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form"

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.clearAllMocks()
  vi.useRealTimers()
  widgetProps.length = 0
  widgetToken.value = "synthetic-token"
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
    expect(readLastSignInMethod()).toBe("password")
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
    expect(readLastSignInMethod()).toBe("password")
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
    expect(readLastSignInMethod()).toBe("password")
  })

  it("says what the trial gives before asking for anything", () => {
    render(<SignupForm />)
    expect(
      screen.getByText("Every feature free for 14 days. No card needed.")
    ).toBeTruthy()
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
    expect(signUpEmail.mock.calls[0][0]).not.toHaveProperty("turnstileToken")
    expect(widgetProps).toEqual([])
  })
})

describe("signup Turnstile", () => {
  function fill() {
    type("Name", "Cook")
    type("Email", "cook@example.test")
    type("Password", "longenough")
  }

  it("sends the widget's token with the account and nothing else changes", async () => {
    render(<SignupForm turnstileSiteKey="site-key" />)
    expect(widgetProps[0]).toEqual({ siteKey: "site-key", resetSignal: 0 })
    fill()
    signUpEmail.mockResolvedValue({})
    fireEvent.click(screen.getByRole("button", { name: "Create account" }))
    await vi.waitFor(() => expect(signUpEmail).toHaveBeenCalledTimes(1))
    expect(signUpEmail.mock.calls[0][0]).toEqual({
      name: "Cook",
      email: "cook@example.test",
      password: "longenough",
      turnstileToken: "synthetic-token",
    })
  })

  it("asks for a fresh token after a refused submit", async () => {
    render(<SignupForm turnstileSiteKey="site-key" />)
    fill()
    signUpEmail.mockResolvedValue({
      error: { message: "Nope.", code: "verification_failed" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create account" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Nope.")
    expect(widgetProps.at(-1)?.resetSignal).toBe(1)
  })

  it("gives up on a token that never arrives instead of sending nothing", async () => {
    vi.useFakeTimers()
    widgetToken.value = null
    render(<SignupForm turnstileSiteKey="site-key" />)
    fill()
    fireEvent.click(screen.getByRole("button", { name: "Create account" }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(signUpEmail).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "We couldn't confirm you're a person."
    )
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

describe("Google auth methods", () => {
  it.each([
    ["google-cancelled", "status", "Google sign-in was cancelled."],
    [
      "google-failed",
      "alert",
      "Google sign-in didn't complete. Try again or use your password.",
    ],
  ])("shows the %s notice", (code, role, message) => {
    render(<LoginForm googleEnabled errorCode={authNoticeCode(code)} />)
    expect(screen.getByRole(role).textContent).toBe(message)
    expect(
      screen.getByRole("link", { name: "Continue with Google" })
    ).toBeTruthy()
  })

  it("ignores unknown, inherited and repeated error codes", () => {
    for (const code of [
      undefined,
      "unknown",
      "__proto__",
      ["google-failed", "google-state"],
    ]) {
      expect(authNoticeCode(code)).toBeUndefined()
    }
  })

  it.each([LoginForm, SignupForm])("hides Google when disabled", (Form) => {
    render(<Form googleEnabled={false} />)
    expect(
      screen.queryByRole("link", { name: "Continue with Google" })
    ).toBeNull()
    expect(screen.queryByText("or")).toBeNull()
  })

  it("shows browser memory only on login", () => {
    writeLastSignInMethod("google")
    const { unmount } = render(<LoginForm googleEnabled />)
    expect(screen.getByText("You signed in with Google last time")).toBeTruthy()
    unmount()
    render(<SignupForm googleEnabled />)
    expect(screen.queryByText("You signed in with Google last time")).toBeNull()
  })

  it("does not change browser memory when password sign-in fails", async () => {
    writeLastSignInMethod("google")
    render(<LoginForm googleEnabled />)
    type("Email", "cook@example.com")
    type("Password", "wrong-password")
    signInEmail.mockResolvedValue({ error: { message: "Incorrect password" } })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await screen.findByRole("alert")
    expect(readLastSignInMethod()).toBe("google")
  })
})
