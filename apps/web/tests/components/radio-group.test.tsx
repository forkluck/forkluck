// @vitest-environment jsdom

import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { RadioGroup, RadioItem } from "@/components/ui/radio-group"

afterEach(cleanup)

function CostingBasis() {
  const [value, setValue] = useState("yield")

  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => setValue(next as string)}
      aria-label="Costing basis"
    >
      <RadioItem value="yield">Yield</RadioItem>
      <RadioItem value="purchase">Purchase</RadioItem>
      <RadioItem value="invoice" disabled>
        Invoice
      </RadioItem>
    </RadioGroup>
  )
}

describe("RadioGroup", () => {
  it("groups its items under one radiogroup", () => {
    render(<CostingBasis />)

    const group = screen.getByRole("radiogroup", { name: "Costing basis" })
    expect(group).toBeDefined()
    expect(screen.getAllByRole("radio")).toHaveLength(3)
  })

  it("selects one item at a time", () => {
    render(<CostingBasis />)

    const chosen = screen.getByRole("radio", { name: "Yield" })
    const other = screen.getByRole("radio", { name: "Purchase" })
    expect(chosen.getAttribute("aria-checked")).toBe("true")
    expect(other.getAttribute("aria-checked")).toBe("false")

    fireEvent.click(other)
    expect(
      screen
        .getByRole("radio", { name: "Purchase" })
        .getAttribute("aria-checked")
    ).toBe("true")
    expect(
      screen.getByRole("radio", { name: "Yield" }).getAttribute("aria-checked")
    ).toBe("false")
  })

  it("selects an item from its label", () => {
    render(<CostingBasis />)

    fireEvent.click(screen.getByText("Purchase"))
    expect(
      screen
        .getByRole("radio", { name: "Purchase" })
        .getAttribute("aria-checked")
    ).toBe("true")
  })

  it("leaves a disabled item unselectable", () => {
    render(<CostingBasis />)

    const disabled = screen.getByRole("radio", { name: "Invoice" })
    fireEvent.click(disabled)
    expect(disabled.getAttribute("aria-checked")).toBe("false")
    expect(
      screen.getByRole("radio", { name: "Yield" }).getAttribute("aria-checked")
    ).toBe("true")
  })
})
