// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { PasswordHint } from "@/components/auth/password-hint"

afterEach(cleanup)

const hint = () => screen.getByText(/8 characters/).closest("p")!

it("stays faint until the password reaches eight characters", () => {
  const { rerender } = render(<PasswordHint password="short" />)
  expect(hint().dataset.met).toBeUndefined()
  expect(hint().className).toContain("text-faint")

  rerender(<PasswordHint password="longenough" />)
  expect(hint().dataset.met).toBe("true")
  expect(hint().className).toContain("text-success")
})

it("is not a form control, so it cannot shadow the Password label", () => {
  render(<PasswordHint password="" />)
  expect(hint().getAttribute("role")).toBeNull()
  expect(hint().getAttribute("aria-label")).toBeNull()
})
