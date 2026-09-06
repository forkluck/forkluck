// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { searchNutritionFoods } = vi.hoisted(() => ({
  searchNutritionFoods: vi.fn(),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchNutritionFoods,
}))

import { UsdaFoodCombobox } from "@/components/nutrition/usda-food-combobox"

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  searchNutritionFoods.mockReset()
  searchNutritionFoods.mockResolvedValue({
    items: [
      {
        fdcId: 1,
        description: "Butter, salted",
        dataType: "Foundation",
        brand: "",
      },
      {
        fdcId: 2,
        description: "BUTTER, SALTED, KERRYGOLD",
        dataType: "Branded",
        brand: "Kerrygold",
      },
    ],
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function openAndType(text: string) {
  fireEvent.click(screen.getByRole("button", { name: "Nutrition data" }))
  const input = await screen.findByLabelText("Search USDA foods")
  for (let index = 1; index <= text.length; index += 1) {
    fireEvent.change(input, { target: { value: text.slice(0, index) } })
  }
  return input
}

describe("USDA food combobox", () => {
  it("searches once, 300 ms after the last keystroke", async () => {
    const onChoose = vi.fn()
    render(
      <UsdaFoodCombobox value={null} onChoose={onChoose} onClear={vi.fn()} />
    )
    await openAndType("butter")

    expect(searchNutritionFoods).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(searchNutritionFoods).toHaveBeenCalledTimes(1)
    expect(searchNutritionFoods).toHaveBeenCalledWith("butter", "common")

    expect(await screen.findByText("Butter, salted")).not.toBeNull()
    expect(screen.getByText("Kerrygold")).not.toBeNull()

    fireEvent.click(screen.getByText("Butter, salted"))
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ fdcId: 1, description: "Butter, salted" })
    )
  })

  it("searches the branded catalog again when the pill changes", async () => {
    render(
      <UsdaFoodCombobox value={null} onChoose={vi.fn()} onClear={vi.fn()} />
    )
    await openAndType("butter")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(searchNutritionFoods).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Branded" }))
    await waitFor(() => expect(searchNutritionFoods).toHaveBeenCalledTimes(2))
    expect(searchNutritionFoods).toHaveBeenLastCalledWith("butter", "branded")
  })

  it("shows the linked record and offers to clear it", async () => {
    const onClear = vi.fn()
    render(
      <UsdaFoodCombobox
        value={{ source: "usda_fdc", description: "Butter, salted" }}
        onChoose={vi.fn()}
        onClear={onClear}
      />
    )
    const trigger = screen.getByRole("button", { name: "Nutrition data" })
    expect(trigger.textContent).toContain("USDA")
    expect(trigger.textContent).toContain("Butter, salted")

    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("says when nothing matches", async () => {
    searchNutritionFoods.mockResolvedValue({ items: [] })
    render(
      <UsdaFoodCombobox value={null} onChoose={vi.fn()} onClear={vi.fn()} />
    )
    await openAndType("zz")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(
      await screen.findByText("No foods match. Try fewer words.")
    ).not.toBeNull()
  })
})
