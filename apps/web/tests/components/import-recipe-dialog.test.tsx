// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { ImportRecipeDialog } from "@/components/recipes/import-recipe-dialog"

afterEach(cleanup)

const DOCUMENT = `250 g plain flour
125 g cold butter
4 eggs

Method:
Rub the butter into the flour.
Bake until the filling only just sets.`

function paste(field: HTMLElement, text: string) {
  fireEvent.paste(field, { clipboardData: { getData: () => text } })
}

function openDialog(onApply = vi.fn()) {
  render(
    <ImportRecipeDialog
      open
      part="recipe"
      onOpenChange={vi.fn()}
      onApply={onApply}
    />
  )
  return {
    ingredients: screen.getByLabelText("Ingredients") as HTMLTextAreaElement,
    method: screen.getByLabelText("Prep method") as HTMLTextAreaElement,
    onApply,
  }
}

describe("pasting a whole recipe into the import dialog", () => {
  it("moves the method into the Prep method box", () => {
    const { ingredients, method } = openDialog()

    paste(ingredients, DOCUMENT)

    expect(ingredients.value).toBe(
      "250 g plain flour\n125 g cold butter\n4 eggs"
    )
    expect(method.value).toBe(
      "Rub the butter into the flour.\nBake until the filling only just sets."
    )
  })

  it("applies both boxes as they stand", () => {
    const { ingredients, onApply } = openDialog()

    paste(ingredients, DOCUMENT)
    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    expect(onApply).toHaveBeenCalledWith(
      "250 g plain flour\n125 g cold butter\n4 eggs",
      "Rub the butter into the flour.\nBake until the filling only just sets."
    )
  })

  // Nothing moves in the two cases below, so the paste is left to the
  // browser, which is why the ingredients box reads empty here.
  it("leaves a method the cook already wrote alone", () => {
    const { ingredients, method } = openDialog()

    fireEvent.change(method, { target: { value: "Mix it well." } })
    paste(ingredients, DOCUMENT)

    expect(method.value).toBe("Mix it well.")
    expect(ingredients.value).toBe("")
  })

  it("keeps a plain ingredient list where it was pasted", () => {
    const { ingredients, method } = openDialog()

    paste(ingredients, "250 g plain flour\n125 g cold butter")

    expect(method.value).toBe("")
    expect(ingredients.value).toBe("")
  })
})
