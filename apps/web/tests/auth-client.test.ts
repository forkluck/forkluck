// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"

import { authClient } from "@/lib/auth-client"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("auth request refusals", () => {
  it("carries the server's code beside its sentence", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "Nope.", code: "verification_failed" }),
          { status: 400 }
        )
      )
    vi.stubGlobal("fetch", fetch)
    await expect(
      authClient.signUp.email({
        name: "Cook",
        email: "cook@example.test",
        password: "synthetic",
        turnstileToken: "tok",
      })
    ).resolves.toEqual({
      error: { message: "Nope.", code: "verification_failed" },
    })
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      name: "Cook",
      email: "cook@example.test",
      password: "synthetic",
      turnstileToken: "tok",
    })
  })
})

describe("auth request failures", () => {
  it.each(["csrf", "post"])(
    "returns a retryable error when %s loses the connection",
    async (stage) => {
      const fetch = vi.fn()
      if (stage === "post") {
        fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      }
      fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
      vi.stubGlobal("fetch", fetch)

      await expect(
        authClient.signIn.email({
          email: "cook@example.test",
          password: "synthetic",
        })
      ).resolves.toEqual({
        error: {
          message:
            "Couldn't connect to Forkluck. Check your connection and try again.",
        },
      })
    }
  )

  it("does not continue to the write when the CSRF request fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("maintenance", { status: 503 }))
    vi.stubGlobal("fetch", fetch)
    expect(
      await authClient.requestPasswordReset({ email: "cook@example.test" })
    ).toHaveProperty("error")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("refuses a successful HTTP response with an unreadable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
        .mockResolvedValueOnce(
          new Response("<!doctype html><title>Maintenance</title>")
        )
    )

    expect(
      await authClient.resetPassword({
        email: "cook@example.test",
        code: "123456",
        password: "synthetic",
      })
    ).toHaveProperty("error")
  })
})

describe("authClient.changePassword", () => {
  it("posts only the two password fields through the CSRF-protected auth route", async () => {
    document.cookie = "forkluck_csrf=test-token"
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal("fetch", fetch)

    const result = await authClient.changePassword({
      currentPassword: "current-password-1234",
      newPassword: "new-password-5678",
    })

    expect(result).toEqual({})
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/auth/csrf", {
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    })
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/auth/change-password",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": "test-token",
        },
        body: JSON.stringify({
          currentPassword: "current-password-1234",
          newPassword: "new-password-5678",
        }),
      })
    )
  })
})
