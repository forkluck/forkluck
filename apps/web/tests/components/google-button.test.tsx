// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { GoogleButton } from "@/components/auth/google-button"
import {
  readLastSignInMethod,
  writeLastSignInMethod,
} from "@/components/auth/last-sign-in-method"

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe("GoogleButton", () => {
  it.each([
    ["/", "/api/auth/google/start"],
    [
      "/recipes?view=all",
      "/api/auth/google/start?next=%2Frecipes%3Fview%3Dall",
    ],
  ])("carries the continuation %s", (next, href) => {
    render(<GoogleButton next={next} />)
    const link = screen.getByRole("link", { name: "Continue with Google" })
    expect(link.getAttribute("href")).toBe(href)
    expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
  })

  it("remembers Google and shows pending through document navigation", () => {
    render(<GoogleButton />)
    const link = screen.getByRole("link", { name: "Continue with Google" })
    // The browser tests inspect the link; unit tests stop JSDOM navigating.
    link.addEventListener("click", (event) => event.preventDefault())
    fireEvent.click(link)
    expect(readLastSignInMethod()).toBe("google")
    expect(link.getAttribute("aria-busy")).toBe("true")
    expect(link.getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByRole("status")).toBeTruthy()
    fireEvent(window, new Event("pageshow"))
    expect(link.hasAttribute("aria-busy")).toBe(false)
  })

  it("does not leave the original document busy on a modified click", () => {
    render(<GoogleButton />)
    const link = screen.getByRole("link", { name: "Continue with Google" })
    link.addEventListener("click", (event) => event.preventDefault())
    fireEvent.click(link, { metaKey: true })
    expect(readLastSignInMethod()).toBe("google")
    expect(link.hasAttribute("aria-busy")).toBe(false)
  })

  it("tolerates blocked storage and ignores unknown methods", () => {
    window.localStorage.setItem("fl.last-sign-in-method", "unknown")
    expect(readLastSignInMethod()).toBeNull()
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readLastSignInMethod()).toBeNull()
    expect(() => writeLastSignInMethod("password")).not.toThrow()
  })
})
