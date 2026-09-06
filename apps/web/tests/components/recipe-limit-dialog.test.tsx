// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { useRecipeLimitDialog } from "@/components/recipes/recipe-limit-dialog"

afterEach(cleanup)

const REFUSAL = {
  error:
    "You've reached the 10-recipe limit on the Free plan. Upgrade to create unlimited recipes.",
  code: "recipe_limit_reached",
}

function Creator({ result }: { result: { error: string; code?: string } }) {
  const recipeLimit = useRecipeLimitDialog()
  return (
    <div>
      <button type="button" onClick={() => recipeLimit.show(result)}>
        Create
      </button>
      {recipeLimit.dialog}
    </div>
  )
}

describe("the recipe limit dialog", () => {
  it("reports the cap in the server's own words, with a way to upgrade", () => {
    render(<Creator result={REFUSAL} />)

    fireEvent.click(screen.getByRole("button", { name: "Create" }))

    expect(screen.getByText(REFUSAL.error)).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Upgrade" }).getAttribute("href")
    ).toBe("/subscribe")

    fireEvent.click(screen.getByRole("button", { name: "Not now" }))
    expect(screen.queryByText(REFUSAL.error)).toBeNull()
  })

  it("stays shut for any other refusal", () => {
    render(<Creator result={{ error: "Couldn’t save the recipe." }} />)

    fireEvent.click(screen.getByRole("button", { name: "Create" }))

    expect(screen.queryByText("Couldn’t save the recipe.")).toBeNull()
  })
})
