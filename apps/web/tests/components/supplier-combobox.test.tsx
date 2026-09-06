// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SupplierCombobox } from "@/components/invoices/supplier-combobox"

afterEach(cleanup)

describe("SupplierCombobox", () => {
  it("picks a supplier the workspace already buys from", async () => {
    const onChange = vi.fn()
    render(
      <SupplierCombobox
        value="Acme Foods"
        onChange={onChange}
        options={["Acme Foods", "Vestal"]}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Supplier" }))
    fireEvent.click(await screen.findByText("Vestal"))

    expect(onChange).toHaveBeenCalledWith("Vestal")
  })

  it("takes the name off the document when it is a new one", async () => {
    const onChange = vi.fn()
    render(
      <SupplierCombobox value="" onChange={onChange} options={["Acme Foods"]} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Supplier" }))
    fireEvent.change(await screen.findByPlaceholderText("Search or add"), {
      target: { value: "Chef’s Warehouse" },
    })
    fireEvent.click(screen.getByText("Add “Chef’s Warehouse”"))

    expect(onChange).toHaveBeenCalledWith("Chef’s Warehouse")
  })
})
