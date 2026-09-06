// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const saveIngredient = vi.fn()

vi.mock("@/app/(app)/ingredients/actions", () => ({
  saveIngredient: (input: unknown) => saveIngredient(input),
  archiveIngredient: vi.fn(),
  deleteIngredient: vi.fn(),
  deletePreparations: vi.fn(),
  savePreparation: vi.fn(),
  saveIngredientConversion: vi.fn(),
  resetIngredientConversion: vi.fn(),
  searchInvoiceItems: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  usePathname: () => "/ingredients/ing_1/ingredient",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "metric",
  }),
}))

import {
  IngredientChrome,
  useIngredientFormBinding,
} from "@/components/ingredients/ingredient-chrome"
import {
  IngredientForm,
  type IngredientFormValues,
} from "@/components/ingredients/ingredient-form"
import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"

afterEach(() => {
  cleanup()
  saveIngredient.mockReset()
})

const BUTTER: IngredientFormValues = {
  id: "ing-1",
  name: "Butter",
  category: null,
  editVersion: 2,
  purchaseCostCents: 500,
  purchaseSize: 1,
  purchaseUnit: "lb",
  priceSource: "user",
  tags: [],
}

function Panel({ initial }: { initial: IngredientFormValues | null }) {
  const binding = useIngredientFormBinding()
  return (
    <IngredientForm
      {...binding}
      section="ingredient"
      profileLayout
      initial={initial}
      availableTags={[{ id: "tag-1", name: "Dairy", count: 1 }]}
      onDone={vi.fn()}
    />
  )
}

/** What every guarded exit reads before it lets go. */
function BlockedProbe() {
  const { isBlocked } = useNavigationBlocker()
  return <span data-testid="blocked">{String(isBlocked)}</span>
}

function ingredientScreen(initial: IngredientFormValues | null = BUTTER) {
  render(
    <NavigationBlockerProvider>
      <BlockedProbe />
      {initial ? (
        <IngredientChrome id="ing-1" name="Butter" publicId="ing_1">
          <Panel initial={initial} />
        </IngredientChrome>
      ) : (
        <IngredientChrome name="New ingredient">
          <Panel initial={null} />
        </IngredientChrome>
      )}
    </NavigationBlockerProvider>
  )
}

function blocked() {
  return screen.getByTestId("blocked").textContent
}

function badge() {
  return screen.getAllByRole("status")[0].textContent
}

function headerSave() {
  return screen.getByRole("button", { name: "Save" })
}

function rename(value: string) {
  fireEvent.change(screen.getByLabelText("Name (required)"), {
    target: { value },
  })
}

const saved = (editVersion: number) => ({
  id: "ing-1",
  publicId: "ing_1",
  editVersion,
})

describe("the ingredient form under the header's Save", () => {
  it("sends the whole ingredient, tags included, and adopts the new version", async () => {
    saveIngredient.mockResolvedValue(saved(3))
    ingredientScreen()

    rename("Butter, unsalted")
    fireEvent.click(screen.getByRole("button", { name: "Add tags" }))
    fireEvent.click(screen.getByRole("button", { name: "Dairy" }))
    expect(badge()).toBe("Draft")

    fireEvent.click(headerSave())
    await vi.waitFor(() => expect(badge()).toBe("Saved"))
    expect(saveIngredient).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ing-1",
        name: "Butter, unsalted",
        tags: ["Dairy"],
        expectedEditVersion: 2,
      })
    )

    saveIngredient.mockResolvedValue(saved(4))
    rename("Butter, salted")
    fireEvent.click(headerSave())
    await vi.waitFor(() => expect(saveIngredient).toHaveBeenCalledTimes(2))
    expect(saveIngredient.mock.calls[1][0].expectedEditVersion).toBe(3)
  })

  it("sends nothing when nothing was touched", async () => {
    ingredientScreen()

    fireEvent.click(headerSave())
    await vi.waitFor(() => expect(badge()).toBe("Saved"))
    expect(saveIngredient).not.toHaveBeenCalled()
  })

  it("asks for a name instead of saving, and keeps Save pressable", async () => {
    ingredientScreen()

    rename("")
    fireEvent.click(headerSave())

    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Enter a name.")
    )
    expect(saveIngredient).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect((headerSave() as HTMLButtonElement).disabled).toBe(false)
    )
    // Failing validation leaves a draft, not a failed save.
    expect(badge()).toBe("Draft")
    expect(document.activeElement).toBe(
      screen.getByLabelText("Name (required)")
    )
  })

  it("takes one request from two presses", async () => {
    let finish: ((result: unknown) => void) | null = null
    saveIngredient.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    ingredientScreen()

    rename("Butter, unsalted")
    fireEvent.click(headerSave())
    fireEvent.click(headerSave())
    await vi.waitFor(() => expect(badge()).toBe("Saving…"))
    expect(saveIngredient).toHaveBeenCalledTimes(1)

    finish!(saved(3))
    await vi.waitFor(() => expect(badge()).toBe("Saved"))
  })

  it("reads Not saved after a request that failed, and Saved on the retry", async () => {
    saveIngredient.mockResolvedValue({ error: "Backend is down" })
    ingredientScreen()

    rename("Butter, unsalted")
    fireEvent.click(headerSave())
    await vi.waitFor(() => expect(badge()).toBe("Not saved"))
    expect(screen.getByRole("alert").textContent).toContain("Backend is down")

    saveIngredient.mockResolvedValue(saved(3))
    fireEvent.click(headerSave())
    await vi.waitFor(() => expect(badge()).toBe("Saved"))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("says so and offers a reload when the ingredient changed elsewhere", async () => {
    saveIngredient.mockResolvedValue({
      error: "This ingredient changed in another window.",
      code: "stale_write",
      editVersion: 5,
    })
    ingredientScreen()

    rename("Butter, unsalted")
    fireEvent.click(headerSave())

    await vi.waitFor(() => expect(badge()).toBe("Changed elsewhere"))
    expect(screen.getByRole("button", { name: "Reload" })).not.toBeNull()
    expect(
      (screen.getByLabelText("Name (required)") as HTMLInputElement).value
    ).toBe("Butter, unsalted")
  })

  it("leaves the create screen alone until something is typed", () => {
    ingredientScreen(null)

    expect(blocked()).toBe("false")
    expect(badge()).toBe("")
    rename("Ghee")
    expect(blocked()).toBe("true")
    expect(badge()).toBe("Draft")
  })

  it("still sends the first press on the create screen", async () => {
    saveIngredient.mockResolvedValue({
      id: "ing-2",
      publicId: "ing_2",
      editVersion: 1,
    })
    ingredientScreen(null)

    rename("Ghee")
    fireEvent.click(headerSave())

    await vi.waitFor(() => expect(saveIngredient).toHaveBeenCalledTimes(1))
    expect(saveIngredient.mock.calls[0][0]).toEqual(
      expect.objectContaining({ id: null, name: "Ghee" })
    )
  })

  it("saves on Cmd+S", async () => {
    saveIngredient.mockResolvedValue(saved(3))
    ingredientScreen()

    rename("Butter, unsalted")
    fireEvent.keyDown(window, { key: "s", metaKey: true })

    await vi.waitFor(() => expect(saveIngredient).toHaveBeenCalledTimes(1))
  })
})
