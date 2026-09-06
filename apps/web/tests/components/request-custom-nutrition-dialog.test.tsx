// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const requestCustomNutrition = vi.hoisted(() => vi.fn())
const toastAdd = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/ingredients/actions", () => ({ requestCustomNutrition }))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

import { RequestCustomNutritionDialog } from "@/components/nutrition/request-custom-nutrition-dialog"

const REQUIRED = [
  ["Calories", "120"],
  ["Total fat", "3"],
  ["Saturated fat", "1"],
  ["Sodium", "80"],
  ["Total carbohydrate", "20"],
  ["Total sugars", "2"],
  ["Protein", "5"],
] as const

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function send(onOpenChange = vi.fn()) {
  render(
    <RequestCustomNutritionDialog
      ingredientId="ing-1"
      ingredientName="Oat milk"
      open
      onOpenChange={onOpenChange}
    />
  )
  for (const [label, value] of REQUIRED) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send request" }))
  })
}

describe("the custom nutrition request dialog", () => {
  it("closes only once the request landed", async () => {
    requestCustomNutrition.mockResolvedValue({ ok: true })
    const onOpenChange = vi.fn()

    await send(onOpenChange)

    expect(requestCustomNutrition).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("stays open and says why when the request did not land", async () => {
    requestCustomNutrition.mockResolvedValue({ error: "Backend is down" })
    const onOpenChange = vi.fn()

    await send(onOpenChange)

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Backend is down")
  })
})
