// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const listSuppliers = vi.hoisted(() => vi.fn())
const saveSupplier = vi.hoisted(() => vi.fn())
const mergeSuppliers = vi.hoisted(() => vi.fn())
const deleteSupplier = vi.hoisted(() => vi.fn())
const listExpenseCategories = vi.hoisted(() => vi.fn())
vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/settings/actions", () => ({
  listSuppliers,
  saveSupplier,
  mergeSuppliers,
  deleteSupplier,
}))
vi.mock("@/app/(app)/invoices/actions", () => ({ listExpenseCategories }))

import { SuppliersList } from "@/components/settings/suppliers-list"

const rows = [
  {
    id: "sup-1",
    key: "acme",
    name: "Acme Foods",
    email: "",
    phone: "",
    accountNumber: "",
    notes: "",
    defaultCategoryId: "cat-produce",
    invoiceCount: 3,
    itemCount: 2,
    ignoreCount: 1,
  },
  {
    id: "sup-2",
    key: "vestal",
    name: "Vestal",
    email: "",
    phone: "",
    accountNumber: "",
    notes: "",
    defaultCategoryId: null,
    invoiceCount: 0,
    itemCount: 0,
    ignoreCount: 0,
  },
]

const CATEGORIES = [
  {
    id: "cat-produce",
    name: "Produce",
    isIngredient: false,
    isSupply: false,
    position: 1,
  },
  {
    id: "cat-dry",
    name: "Dry goods",
    isIngredient: false,
    isSupply: false,
    position: 2,
  },
]

beforeEach(() => {
  listSuppliers.mockResolvedValue(rows)
  listExpenseCategories.mockResolvedValue(CATEGORIES)
  saveSupplier.mockResolvedValue({ ok: true })
  mergeSuppliers.mockResolvedValue({ ok: true })
  deleteSupplier.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function list() {
  render(<SuppliersList />)
}

describe("the suppliers list", () => {
  it("lists each supplier with its invoices", async () => {
    list()

    expect(await screen.findByText("Acme Foods")).toBeTruthy()
    expect(screen.getByText("3 invoices")).toBeTruthy()
    expect(screen.getByText("0 invoices")).toBeTruthy()
  })

  it("adds a supplier", async () => {
    list()
    await screen.findByText("Acme Foods")

    fireEvent.click(screen.getByRole("button", { name: "+ Add supplier" }))
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Chef’s Warehouse" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(saveSupplier).toHaveBeenCalledWith({
      id: undefined,
      name: "Chef’s Warehouse",
      email: "",
      phone: "",
      accountNumber: "",
      notes: "",
      defaultCategoryId: null,
    })
  })

  it("names the category a supplier's lines fall back to", async () => {
    list()

    expect(await screen.findByText("Produce")).toBeTruthy()
  })

  it("sends the default category the dialog picked", async () => {
    list()
    await screen.findByText("Acme Foods")
    fireEvent.click(screen.getByRole("button", { name: "+ Add supplier" }))
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Chef’s Warehouse" },
    })

    const trigger = screen.getByLabelText("Default category")
    fireEvent.pointerDown(trigger)
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    const option = await screen.findByRole("option", { name: "Dry goods" })
    fireEvent.pointerDown(option)
    fireEvent.mouseDown(option)
    fireEvent.pointerUp(option)
    fireEvent.mouseUp(option)
    fireEvent.click(option)

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(saveSupplier).toHaveBeenCalled())
    expect(saveSupplier.mock.calls[0][0].defaultCategoryId).toBe("cat-dry")
  })

  it("edits a supplier through the same form", async () => {
    list()
    await screen.findByText("Acme Foods")

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Acme Foods" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }))

    expect((await screen.findByLabelText("Name")).getAttribute("value")).toBe(
      "Acme Foods"
    )
  })

  it("names what a merge moves before it moves it", async () => {
    list()
    await screen.findByText("Acme Foods")

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Acme Foods" })
    )
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Merge into…" })
    )
    fireEvent.click(await screen.findByRole("combobox", { name: "Merge into" }))
    fireEvent.click(await screen.findByRole("option", { name: "Vestal" }))

    expect(
      await screen.findByText(
        "3 invoices, 2 items and 1 ignored item move to Vestal. Acme Foods is removed."
      )
    ).toBeTruthy()
    expect(mergeSuppliers).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Merge" }))

    expect(mergeSuppliers).toHaveBeenCalledWith("sup-1", "sup-2")
  })

  it("will not delete a supplier that still has invoices or items", async () => {
    list()
    await screen.findByText("Acme Foods")

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Acme Foods" })
    )
    const used = await screen.findByRole("menuitem", { name: "Delete" })

    expect(used.getAttribute("data-disabled")).not.toBeNull()
  })

  it("deletes a supplier nothing points at", async () => {
    list()
    await screen.findByText("Vestal")

    fireEvent.click(screen.getByRole("button", { name: "Actions for Vestal" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete", hidden: true })
    )

    expect(deleteSupplier).toHaveBeenCalledWith("sup-2")
  })
})

async function openSupplierForm() {
  list()
  await screen.findByText("Acme Foods")
  fireEvent.click(screen.getByRole("button", { name: "+ Add supplier" }))
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Chef’s Warehouse" },
  })
}

describe("saving a supplier", () => {
  it("closes only once the save landed", async () => {
    await openSupplierForm()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })

    expect(saveSupplier).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText("Name")).toBeNull()
  })

  it("stays open and says why when the save did not land", async () => {
    saveSupplier.mockResolvedValue({ error: "Backend is down" })
    await openSupplierForm()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })

    expect(screen.getByText("Backend is down")).toBeTruthy()
    expect(screen.getByLabelText("Name")).toBeTruthy()
  })
})

async function openMerge() {
  list()
  await screen.findByText("Acme Foods")
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for Acme Foods" })
  )
  fireEvent.click(await screen.findByRole("menuitem", { name: "Merge into…" }))
  fireEvent.click(await screen.findByRole("combobox", { name: "Merge into" }))
  fireEvent.click(await screen.findByRole("option", { name: "Vestal" }))
}

describe("merging suppliers", () => {
  it("closes only once the merge landed", async () => {
    await openMerge()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Merge" }))
    })

    expect(mergeSuppliers).toHaveBeenCalledWith("sup-1", "sup-2")
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
  })

  it("stays open and says why when the merge did not land", async () => {
    mergeSuppliers.mockResolvedValue({ error: "Backend is down" })
    await openMerge()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Merge" }))
    })

    expect(screen.getByText("Backend is down")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy()
  })
})
