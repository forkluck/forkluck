// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const saveRecipeAggregate = vi.fn()
const toastAdd = vi.fn()

vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  deleteRecipeComment: vi.fn(),
  removeRecipeShare: vi.fn(),
  saveRecipe: vi.fn(),
  saveRecipeAggregate: (...args: unknown[]) => saveRecipeAggregate(...args),
  saveRecipeComment: vi.fn(),
  shareRecipe: vi.fn(),
  updateRecipeShare: vi.fn(),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  activateCatalogIngredient: vi.fn(),
  saveIngredient: vi.fn(),
  savePreparation: vi.fn(),
  saveRecipeLineMatch: vi.fn(),
  searchCatalogIngredients: vi.fn().mockResolvedValue({ items: [] }),
}))

const refresh = vi.fn()

vi.mock("next/navigation", () => ({
  usePathname: () => "/recipes/new",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}))

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "metric",
  }),
}))

import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"
import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome } from "@/components/recipes/recipe-chrome"
import type { RecipeDetail } from "@/lib/backend/types"

/** A recipe that already exists, which is all the editor reads of one. */
const SAVED = {
  id: "rec-1",
  publicId: "abc123",
  userId: "owner-1",
  editVersion: 4,
  title: "Focaccia",
  description: "",
  status: "active",
  category: "",
  permission: "owner",
  canEdit: true,
  yieldAmount: null,
  yieldUnit: "pcs",
  servingAmount: null,
  servingUnit: "",
  shelfLifeAmount: null,
  shelfLifeUnit: "",
  autoSumYieldEnabled: false,
  percentageMode: "",
  percentIngredientEnabled: false,
  percentIngredientType: "",
  items: [],
  steps: [],
  equivalency: null,
  tags: [],
  comments: [],
  ingredientOptions: [],
  recipeOptions: [],
} as unknown as RecipeDetail

/** Whoever wants to leave asks the blocker first, exactly as a link does. */
function LeaveButton({ onAnswer }: { onAnswer: (allowed: boolean) => void }) {
  const { confirmNavigation } = useNavigationBlocker()
  return (
    <button
      type="button"
      onClick={() => void confirmNavigation().then(onAnswer)}
    >
      Leave
    </button>
  )
}

function editorScreen({
  initial = null,
  onAnswer = () => undefined,
}: {
  initial?: RecipeDetail | null
  onAnswer?: (allowed: boolean) => void
} = {}) {
  render(
    <NavigationBlockerProvider>
      <RecipeChrome
        id={initial?.id}
        publicId={initial?.publicId}
        title={initial?.title ?? "New recipe"}
      >
        <RecipeEditor
          currentUserId="user-1"
          initial={initial}
          sources={{ items: [], recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
      <LeaveButton onAnswer={onAnswer} />
    </NavigationBlockerProvider>
  )
}

function titleField() {
  return screen.getByLabelText("Name (required)") as HTMLInputElement
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

/** Let the effects run and the saves they started settle. */
async function settle(ms = 0) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

function badge() {
  return screen.getByRole("status").textContent
}

beforeEach(() => {
  vi.useFakeTimers()
  window.history.replaceState(null, "", "/recipes/new")
  window.localStorage.clear()
  saveRecipeAggregate.mockResolvedValue({
    id: "rec-1",
    publicId: "abc123",
    code: "R1",
    editVersion: 5,
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  saveRecipeAggregate.mockReset()
  toastAdd.mockReset()
  refresh.mockReset()
})

describe("a recipe that saves itself", () => {
  it("saves three seconds after the change, and not before", async () => {
    editorScreen({ initial: SAVED })

    type("Description", "Slow rise")
    expect(badge()).toBe("Draft")
    await settle(2999)
    expect(saveRecipeAggregate).not.toHaveBeenCalled()

    await settle(1)
    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(saveRecipeAggregate.mock.calls[0][0]).toMatchObject({
      id: "rec-1",
      description: "Slow rise",
    })
    expect(badge()).toBe("Saved")
    // Nothing was asked for, so nothing is announced.
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("says so while it saves", async () => {
    let finish: ((profile: unknown) => void) | null = null
    saveRecipeAggregate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    editorScreen({ initial: SAVED })

    type("Description", "Slow rise")
    await settle(3000)
    expect(badge()).toBe("Saving…")

    await act(async () => {
      finish?.({ id: "rec-1", publicId: "abc123", code: "R1", editVersion: 5 })
    })
    expect(badge()).toBe("Saved")
  })

  it("saves a rename the moment the cook leaves the name field", async () => {
    editorScreen({ initial: SAVED })

    type("Name (required)", "Focaccia Genovese")
    fireEvent.blur(titleField())
    await settle()

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(saveRecipeAggregate.mock.calls[0][0]).toMatchObject({
      id: "rec-1",
      title: "Focaccia Genovese",
    })
    expect(badge()).toBe("Saved")
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Focaccia Genovese"
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  it("leaves an unchanged name alone on blur", async () => {
    editorScreen({ initial: SAVED })

    fireEvent.blur(titleField())
    await settle(3000)

    expect(saveRecipeAggregate).not.toHaveBeenCalled()
  })

  it("saves every minute for a cook who never stops typing", async () => {
    editorScreen({ initial: SAVED })

    for (let i = 0; i < 40; i++) {
      type("Description", `Slow rise ${i}`)
      await settle(2000)
    }

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(saveRecipeAggregate.mock.calls[0][0].description).toMatch(
      /^Slow rise/
    )
  })

  it("reads Not saved after a save that failed, until the next one lands", async () => {
    saveRecipeAggregate.mockResolvedValueOnce({ error: "Backend is down" })
    editorScreen({ initial: SAVED })

    type("Description", "Slow rise")
    await settle(3000)
    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(badge()).toBe("Not saved")
    expect(toastAdd).not.toHaveBeenCalled()

    // Still not saved between keystrokes: the typing changed nothing about
    // what the server holds.
    type("Description", "Slow rise, hot oven")
    expect(badge()).toBe("Not saved")

    await settle(3000)
    expect(saveRecipeAggregate).toHaveBeenCalledTimes(2)
    expect(badge()).toBe("Saved")
  })
})

describe("a recipe saved for the first time", () => {
  it("waits for the whole name rather than saving the first letter", async () => {
    editorScreen()

    for (const typed of [
      "F",
      "Fo",
      "Foc",
      "Foca",
      "Focac",
      "Focacc",
      "Focacci",
      "Focaccia",
    ]) {
      type("Name (required)", typed)
      await settle(500)
    }
    expect(saveRecipeAggregate).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe("/recipes/new")
    // A reload inside the quiet spell would lose the whole recipe.
    const leave = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true)

    await settle(3000)
    const stay = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(stay)
    expect(stay.defaultPrevented).toBe(false)
    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(saveRecipeAggregate.mock.calls[0][0]).toMatchObject({
      id: null,
      title: "Focaccia",
    })
    expect(window.location.pathname).toBe("/recipes/abc123/recipe")
    // Same editor, same typing: nothing was unmounted on the way, and
    // nothing asked the router to rebuild the screen from the server, which
    // at the new URL would be a different screen.
    expect(titleField().value).toBe("Focaccia")
    expect(refresh).not.toHaveBeenCalled()
    expect(badge()).toBe("Saved")
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("names the breadcrumb and opens Cost without a trip to the server", async () => {
    editorScreen()
    // The Cost tab is there from the start, disabled until the recipe exists.
    expect(
      screen.getByRole("link", { name: "Cost" }).getAttribute("aria-disabled")
    ).toBe("true")

    type("Name (required)", "Focaccia")
    fireEvent.blur(titleField())
    await settle()

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Focaccia"
    )
    expect(
      screen.getByRole("link", { name: "Cost" }).getAttribute("href")
    ).toBe("/recipes/abc123/cost")
    expect(refresh).not.toHaveBeenCalled()
  })

  it("saves the name as soon as the cook leaves the field", async () => {
    editorScreen()

    type("Name (required)", "Focaccia")
    fireEvent.blur(titleField())
    await settle()

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(saveRecipeAggregate.mock.calls[0][0]).toMatchObject({
      id: null,
      title: "Focaccia",
    })
    expect(badge()).toBe("Saved")
  })

  it("hands the chrome the ids the tabs and sharing need", async () => {
    editorScreen()
    expect(
      screen
        .getByRole("link", { name: "Nutrition" })
        .getAttribute("aria-disabled")
    ).toBe("true")

    type("Name (required)", "Focaccia")
    await settle(3000)

    expect(
      screen.getByRole("link", { name: "Nutrition" }).getAttribute("href")
    ).toBe("/recipes/abc123/nutrition")
    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    expect(
      screen
        .getByRole("menuitem", { name: "Share…" })
        .getAttribute("aria-disabled")
    ).not.toBe("true")
  })

  it("creates an Untitled recipe when lines arrive before a name", async () => {
    editorScreen()
    expect(badge()).toBe("New")

    fireEvent.change(screen.getByLabelText("Quick add ingredient"), {
      target: { value: "2 cups flour" },
    })
    fireEvent.keyDown(screen.getByLabelText("Quick add ingredient"), {
      key: "Enter",
    })
    await settle()

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(saveRecipeAggregate.mock.calls[0][0]).toMatchObject({
      id: null,
      title: "Untitled",
    })
    expect(titleField().value).toBe("")
    expect(badge()).toBe("Saved")
  })

  it("stays a draft while a yield amount waits for its unit", async () => {
    editorScreen({ initial: { ...SAVED, yieldUnit: "" } })

    type("Total yield amount", "350")
    await settle(3000)

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(saveRecipeAggregate.mock.calls[0][0]).not.toHaveProperty(
      "yieldAmount"
    )
    expect(screen.getByRole("alert").textContent).toBe(
      "Pick a unit to save this"
    )
    expect(badge()).toBe("Draft")
  })

  it("saves on Cmd+S from inside a field", async () => {
    editorScreen({ initial: SAVED })

    type("Description", "Slow rise")
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await settle()

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Recipe saved" })
    )
  })

  it("sends the new id with a change queued behind the create", async () => {
    let finish: ((profile: unknown) => void) | null = null
    saveRecipeAggregate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    editorScreen()

    type("Name (required)", "Focaccia")
    fireEvent.blur(titleField())
    await settle()
    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)

    type("Description", "Typed while the create was in flight")
    await act(async () => {
      finish?.({ id: "rec-1", publicId: "abc123", code: "R1", editVersion: 5 })
    })
    await settle(3000)

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(2)
    expect(saveRecipeAggregate.mock.calls[1][0]).toMatchObject({
      id: "rec-1",
      description: "Typed while the create was in flight",
    })
  })

  it("saves nothing while there is nothing worth keeping", async () => {
    editorScreen()

    type("Description", "Something for later")
    await settle(120000)

    expect(saveRecipeAggregate).not.toHaveBeenCalled()
  })
})

describe("leaving the page", () => {
  it("saves and goes when there are unsaved changes", async () => {
    const answer = vi.fn()
    editorScreen({ initial: SAVED, onAnswer: answer })
    type("Description", "Slow rise")

    fireEvent.click(screen.getByRole("button", { name: "Leave" }))
    await settle()

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith(true)
    expect(screen.queryByText("Leave without saving?")).toBeNull()
  })

  it("asks only when the save failed", async () => {
    saveRecipeAggregate.mockResolvedValue({ error: "Backend is down" })
    const answer = vi.fn()
    editorScreen({ initial: SAVED, onAnswer: answer })
    type("Description", "Slow rise")

    fireEvent.click(screen.getByRole("button", { name: "Leave" }))
    await settle()

    expect(screen.getByText("Leave without saving?")).not.toBeNull()
    expect(answer).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole("button", { name: "Leave without saving" })
    )
    await settle()
    expect(answer).toHaveBeenCalledWith(true)
  })
})

describe("commercial costing ownership", () => {
  it("does not overwrite the Cost tab portion during a quiet recipe save", async () => {
    editorScreen({
      initial: { ...SAVED, servingAmount: 1, servingUnit: "each" },
    })

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated description" },
    })
    await settle(3000)

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    const sent = saveRecipeAggregate.mock.calls[0][0]
    expect("servingAmount" in sent).toBe(false)
    expect("servingUnit" in sent).toBe(false)
    expect(sent.description).toBe("Updated description")
  })
})

describe("picking a match for a line", () => {
  /** The same recipe with one unlinked line, and a pantry row to link it to. */
  const WITH_LINE = {
    ...SAVED,
    items: [
      {
        id: "item-1",
        kind: "ingredient",
        displayName: "flour",
        quantity: 250,
        unit: "g",
        preparationNote: "",
        efficiency: 100,
        efficiencyAfterCooking: 100,
        isBase: false,
        excludedFromCost: false,
        ingredientId: null,
        subrecipeId: null,
        subrecipe: null,
      },
    ],
    ingredientOptions: [{ id: "pantry-flour", name: "Bread flour" }],
  } as unknown as RecipeDetail

  it("saves the pick at once, without waiting out the quiet spell", async () => {
    editorScreen({ initial: WITH_LINE })

    const field = screen.getAllByLabelText("Ingredient or recipe")[0]
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "flour" } })
    fireEvent.click(screen.getByRole("option", { name: /Bread flour/ }))
    await act(async () => {})

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(saveRecipeAggregate.mock.calls[0][0].items[0]).toMatchObject({
      displayName: "Bread flour",
      ingredientId: "pantry-flour",
    })
  })
})

describe("a save the server would not take", () => {
  it("reads Not saved when the request threw", async () => {
    saveRecipeAggregate.mockRejectedValueOnce(new Error("Backend is down"))
    editorScreen({ initial: SAVED })

    type("Description", "Slow rise")
    await settle(3000)

    expect(badge()).toBe("Not saved")
  })

  it("sends the version it was given, and the one the save answered with", async () => {
    editorScreen({ initial: SAVED })

    type("Description", "Slow rise")
    await settle(3000)
    type("Description", "Slow rise, hot oven")
    await settle(3000)

    expect(saveRecipeAggregate.mock.calls[0][0].expectedEditVersion).toBe(4)
    expect(saveRecipeAggregate.mock.calls[1][0].expectedEditVersion).toBe(5)
  })

  it("stops saving and offers a way out when the recipe changed elsewhere", async () => {
    saveRecipeAggregate.mockResolvedValue({
      error: "This recipe changed in another window. Reload to see the latest.",
      code: "stale_write",
    })
    editorScreen({ initial: SAVED })

    type("Description", "Slow rise")
    await settle(3000)

    expect(badge()).toBe("Changed elsewhere")
    expect(
      screen.getByText(
        "This recipe changed in another window. Reload to see the latest."
      )
    ).not.toBeNull()
    expect(screen.getByRole("button", { name: "Reload" })).not.toBeNull()

    // A later change is kept on screen, but never sent against the same
    // version the server already refused.
    type("Description", "Slow rise, hot oven")
    await settle(3000)
    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
  })
})

describe("the header's Save pressed twice", () => {
  it("sends one save, not two", async () => {
    let finish: ((profile: unknown) => void) | null = null
    saveRecipeAggregate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    editorScreen({ initial: SAVED })
    type("Description", "Slow rise")

    const save = screen.getByRole("button", { name: "Save" })
    fireEvent.click(save)
    fireEvent.click(save)
    await settle()

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish?.({ id: "rec-1", publicId: "abc123", code: "R1", editVersion: 5 })
    })
  })
})

describe("changes this device kept", () => {
  const KEY = "fl.draft.v1.owner-1.user-1.recipe.rec-1"

  it("offers to put back a draft the server never got", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        payload: {
          title: "Focaccia Genovese",
          description: "Slow rise",
          items: [],
          steps: [],
          batchSizes: [],
          equivalency: null,
          tags: [],
        },
        savedAt: Date.now(),
      })
    )
    editorScreen({ initial: SAVED })

    fireEvent.click(screen.getByRole("button", { name: "Restore" }))
    await settle()

    expect(titleField().value).toBe("Focaccia Genovese")
    expect(badge()).toBe("Draft")
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
  })

  it("keeps a copy while dirty and drops it once the save lands", async () => {
    editorScreen({ initial: SAVED })

    type("Description", "Slow rise")
    await settle()
    expect(window.localStorage.getItem(KEY)).not.toBeNull()

    await settle(3000)
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })
})

describe("tags", () => {
  it("travel with the recipe rather than in a save of their own", async () => {
    editorScreen({
      initial: { ...SAVED, tags: [{ id: "tag-1", name: "Bread" }] },
    })

    type("Description", "Slow rise")
    await settle(3000)

    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)
    expect(saveRecipeAggregate.mock.calls[0][0].tags).toEqual(["Bread"])
  })
})
