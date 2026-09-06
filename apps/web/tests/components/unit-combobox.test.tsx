// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { UnitCombobox } from "@/components/ingredients/unit-combobox"

afterEach(cleanup)

describe("UnitCombobox", () => {
  it("searches controlled units without offering custom creation", async () => {
    render(
      <UnitCombobox
        label="Weight"
        value={null}
        onChange={vi.fn()}
        options={[
          { slug: "mcg", label: "Microgram (mcg)" },
          { slug: "oz", label: "Ounce (oz)" },
        ]}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Weight unit" }))

    expect(await screen.findByPlaceholderText("Search")).not.toBeNull()
    expect(screen.getByText("Microgram")).not.toBeNull()
    expect(screen.getByText("mcg")).not.toBeNull()

    fireEvent.change(screen.getByPlaceholderText("Search"), {
      target: { value: "not-a-unit" },
    })
    expect(screen.getByText("No results")).not.toBeNull()
    expect(screen.queryByText(/Add “/)).toBeNull()
  })
})
