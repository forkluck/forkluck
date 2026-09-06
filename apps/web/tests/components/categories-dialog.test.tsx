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

const listCategories = vi.hoisted(() => vi.fn())
const renameCategory = vi.hoisted(() => vi.fn())
const deleteCategory = vi.hoisted(() => vi.fn())
const saveExpenseCategory = vi.hoisted(() => vi.fn())
const deleteExpenseCategory = vi.hoisted(() => vi.fn())
const listExpenseCategories = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/settings/actions", () => ({
  listCategories,
  renameCategory,
  deleteCategory,
  saveExpenseCategory,
  deleteExpenseCategory,
}))
vi.mock("@/app/(app)/invoices/actions", () => ({ listExpenseCategories }))

import { CategoriesDialog } from "@/components/settings/categories-dialog"

const recipeRows = [
  { id: "cat-1", name: "Pastry", count: 3 },
  { id: "cat-2", name: "Breads", count: 0 },
]
const ingredientRows = [{ id: "cat-3", name: "Dairy", count: 7 }]
const expenseRows = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Paper goods",
    isIngredient: false,
    isSupply: false,
    position: 1,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Ingredients",
    isIngredient: true,
    isSupply: false,
    position: 2,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Packaging",
    isIngredient: true,
    isSupply: true,
    position: 3,
  },
]

beforeEach(() => {
  listCategories.mockImplementation(async (kind: string) =>
    kind === "recipe" ? recipeRows : ingredientRows
  )
  renameCategory.mockResolvedValue({ ok: true })
  deleteCategory.mockResolvedValue({ ok: true })
  listExpenseCategories.mockResolvedValue(expenseRows)
  saveExpenseCategory.mockResolvedValue({ ok: true })
  deleteExpenseCategory.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function open() {
  render(<CategoriesDialog open onOpenChange={vi.fn()} />)
}

describe("the categories dialog", () => {
  it("lists each category with what it holds", async () => {
    open()

    expect(await screen.findByText("Pastry")).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
    expect(screen.getByText("Breads")).toBeTruthy()
    expect(screen.getByText("0")).toBeTruthy()
  })

  it("loads the other vocabulary when the tab changes", async () => {
    open()
    await screen.findByText("Pastry")

    fireEvent.click(screen.getByRole("button", { name: "Ingredients" }))

    expect(await screen.findByText("Dairy")).toBeTruthy()
    expect(screen.queryByText("Pastry")).toBeNull()
    expect(listCategories).toHaveBeenLastCalledWith("ingredient")
  })

  it("renames in place", async () => {
    open()
    await screen.findByText("Pastry")

    fireEvent.click(screen.getByRole("button", { name: "Actions for Pastry" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }))
    const field = await screen.findByLabelText("Rename Pastry")
    fireEvent.change(field, { target: { value: "Pastries" } })
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" })
    })

    expect(renameCategory).toHaveBeenCalledWith("recipe", "Pastry", "Pastries")
    expect(screen.queryByLabelText("Rename Pastry")).toBeNull()
  })

  it("keeps the dialog open and asks when Escape drops a rename", async () => {
    const onOpenChange = vi.fn()
    render(<CategoriesDialog open onOpenChange={onOpenChange} />)
    await screen.findByText("Pastry")

    fireEvent.click(screen.getByRole("button", { name: "Actions for Pastry" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }))
    const field = await screen.findByLabelText("Rename Pastry")
    fireEvent.change(field, { target: { value: "Pastries" } })
    fireEvent.keyDown(field, { key: "Escape" })

    expect(await screen.findByText("Discard changes?")).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("asks before the dialog closes on an in-progress rename", async () => {
    const onOpenChange = vi.fn()
    render(<CategoriesDialog open onOpenChange={onOpenChange} />)
    await screen.findByText("Pastry")

    fireEvent.click(screen.getByRole("button", { name: "Actions for Pastry" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }))
    const field = await screen.findByLabelText("Rename Pastry")
    fireEvent.change(field, { target: { value: "Pastries" } })
    fireEvent.click(screen.getByRole("button", { name: "Done" }))

    expect(await screen.findByText("Discard changes?")).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("asks before a tab change drops an in-progress rename", async () => {
    open()
    await screen.findByText("Pastry")

    fireEvent.click(screen.getByRole("button", { name: "Actions for Pastry" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }))
    const field = await screen.findByLabelText("Rename Pastry")
    fireEvent.change(field, { target: { value: "Pastries" } })
    fireEvent.click(screen.getByRole("button", { name: "Ingredients" }))

    expect(await screen.findByText("Discard changes?")).toBeTruthy()
    expect(listCategories).not.toHaveBeenCalledWith("ingredient")
  })

  it("closes without asking when no rename is open", async () => {
    const onOpenChange = vi.fn()
    render(<CategoriesDialog open onOpenChange={onOpenChange} />)
    await screen.findByText("Pastry")

    fireEvent.click(screen.getByRole("button", { name: "Done" }))

    expect(screen.queryByText("Discard changes?")).toBeNull()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("names the count before deleting", async () => {
    open()
    await screen.findByText("Pastry")

    fireEvent.click(screen.getByRole("button", { name: "Actions for Pastry" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))

    expect(await screen.findByText("Delete Pastry?")).toBeTruthy()
    expect(screen.getByText("3 recipes will be uncategorized.")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    expect(deleteCategory).toHaveBeenCalledWith("recipe", "Pastry")
  })

  it("says nothing uses an empty category", async () => {
    open()
    await screen.findByText("Breads")

    fireEvent.click(screen.getByRole("button", { name: "Actions for Breads" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))

    expect(await screen.findByText("Nothing uses it.")).toBeTruthy()
  })

  it("shows what the server refused", async () => {
    renameCategory.mockResolvedValue({ error: "Couldn’t rename the category." })
    open()
    await screen.findByText("Pastry")

    fireEvent.click(screen.getByRole("button", { name: "Actions for Pastry" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }))
    const field = await screen.findByLabelText("Rename Pastry")
    fireEvent.change(field, { target: { value: "Pastries" } })
    fireEvent.keyDown(field, { key: "Enter" })

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn’t rename the category."
    )
    // The field stays open on a rename that never landed.
    expect(screen.getByLabelText("Rename Pastry")).toBeTruthy()
  })
})

describe("the expenses tab", () => {
  async function expenses() {
    open()
    await screen.findByText("Pastry")
    fireEvent.click(screen.getByRole("button", { name: "Expenses" }))
    return screen.findByText("Paper goods")
  }

  it("lists the workspace's expense categories", async () => {
    await expenses()

    expect(screen.getByText("Ingredients", { selector: "span" })).toBeTruthy()
    expect(screen.queryByText("Pastry")).toBeNull()
  })

  it("renames one by id", async () => {
    await expenses()

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Paper goods" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }))
    const field = await screen.findByLabelText("Rename Paper goods")
    fireEvent.change(field, { target: { value: "Paper" } })
    fireEvent.keyDown(field, { key: "Enter" })

    expect(saveExpenseCategory).toHaveBeenCalledWith({
      id: expenseRows[0].id,
      name: "Paper",
    })
  })

  it("marks a category as a supply category", async () => {
    await expenses()

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Paper goods" })
    )
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Supply category" })
    )

    await waitFor(() =>
      expect(saveExpenseCategory).toHaveBeenCalledWith({
        id: expenseRows[0].id,
        name: "Paper goods",
        isSupply: true,
      })
    )
  })

  it("shows a supply category as one, and lets it be deleted", async () => {
    await expenses()

    expect(screen.getByText("Supply")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Packaging" })
    )
    const remove = await screen.findByRole("menuitem", { name: "Delete" })
    expect(remove.getAttribute("data-disabled")).toBeNull()
  })

  it("adds one from the header", async () => {
    await expenses()

    fireEvent.click(screen.getByRole("button", { name: "+ Add category" }))
    const field = await screen.findByLabelText("New category name")
    fireEvent.change(field, { target: { value: "Repairs" } })
    fireEvent.keyDown(field, { key: "Enter" })

    expect(saveExpenseCategory).toHaveBeenCalledWith({ name: "Repairs" })
  })

  it("says what a delete costs before doing it", async () => {
    await expenses()

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Paper goods" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))

    expect(
      await screen.findByText(
        "Lines keep their spend; they just lose the label."
      )
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    expect(deleteExpenseCategory).toHaveBeenCalledWith(expenseRows[0].id)
  })

  it("will not delete the Ingredients category", async () => {
    await expenses()

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Ingredients" })
    )

    expect(
      (await screen.findByRole("menuitem", { name: "Delete" })).getAttribute(
        "data-disabled"
      )
    ).not.toBeNull()
  })
})
