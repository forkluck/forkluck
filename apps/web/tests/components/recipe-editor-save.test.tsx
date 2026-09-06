// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const saveRecipeAggregate = vi.fn()
const toastAdd = vi.fn()
const replace = vi.fn()

vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
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

vi.mock("next/navigation", () => ({
  usePathname: () => "/recipes/new",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
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

import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome, useRecipeEdit } from "@/components/recipes/recipe-chrome"
import type { RecipeDetail } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  // A new recipe rewrites the address once it saves; the next test starts on
  // the create screen again.
  window.history.replaceState(null, "", "/recipes/new")
  saveRecipeAggregate.mockReset()
  toastAdd.mockReset()
  replace.mockReset()
})

/** What the last save sent, whether the cook asked for it or not. */
function lastSaved() {
  return saveRecipeAggregate.mock.calls.at(-1)?.[0]
}

function newRecipeScreen(ownerId?: string) {
  render(
    <RecipeChrome title="New recipe">
      <RecipeEditor
        currentUserId="user-1"
        ownerId={ownerId}
        initial={null}
        sources={{ items: [], recipes: [] }}
        categoryOptions={[]}
        tagOptions={[]}
      />
    </RecipeChrome>
  )
  return screen.getByRole("button", { name: "Save" })
}

describe("saving a new recipe from the header", () => {
  it("says so out loud, and stays on the screen", async () => {
    saveRecipeAggregate.mockResolvedValue({
      id: "rec-1",
      publicId: "abc123",
      code: "R1",
    })
    const save = newRecipeScreen()

    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Focaccia" },
    })
    fireEvent.click(save)
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Recipe saved" })
      )
    )

    expect(lastSaved()).toMatchObject({ title: "Focaccia" })
    // The editor rewrites the address itself rather than routing away.
    expect(replace).not.toHaveBeenCalled()
  })

  it("creates it in the kitchen the sidebar is in", async () => {
    saveRecipeAggregate.mockResolvedValue({
      id: "rec-1",
      publicId: "abc123",
      code: "R1",
    })
    const save = newRecipeScreen("user-rosa")

    fireEvent.click(save)
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Recipe saved" })
      )
    )
    expect(lastSaved()).toMatchObject({ id: null, ownerId: "user-rosa" })

    // The kitchen is chosen once, at creation: the update that follows must
    // not try to move the recipe.
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Focaccia" },
    })
    fireEvent.click(save)
    await vi.waitFor(() =>
      expect(lastSaved()).toMatchObject({ id: "rec-1", title: "Focaccia" })
    )
    expect(lastSaved().ownerId).toBeUndefined()
  })

  it("saves a recipe with no name as Untitled", async () => {
    saveRecipeAggregate.mockResolvedValue({
      id: "rec-1",
      publicId: "abc123",
      code: "R1",
    })
    const save = newRecipeScreen()
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Something for later" },
    })

    fireEvent.click(save)
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Recipe saved" })
      )
    )

    expect(lastSaved()).toMatchObject({ title: "Untitled" })
  })

  it("leaves a total yield out of the save until it has a unit", async () => {
    saveRecipeAggregate.mockResolvedValue({
      id: "rec-1",
      publicId: "abc123",
      code: "R1",
    })
    const save = newRecipeScreen()
    fireEvent.change(screen.getByLabelText("Total yield amount"), {
      target: { value: "1000" },
    })
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Herb oil" },
    })

    fireEvent.click(save)
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Recipe saved" })
      )
    )
    expect(lastSaved()).toMatchObject({ title: "Herb oil" })
    expect(lastSaved()).not.toHaveProperty("yieldAmount")
    expect(screen.getByRole("alert").textContent).toBe(
      "Pick a unit to save this"
    )
  })

  it("keeps commercial portion settings off the Recipe tab payload", async () => {
    saveRecipeAggregate.mockResolvedValue({
      id: "rec-1",
      publicId: "abc123",
      code: "R1",
    })
    const save = newRecipeScreen()
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Herb oil" },
    })
    expect(screen.queryByLabelText("Portion amount")).toBeNull()

    fireEvent.click(save)
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Recipe saved" })
      )
    )
    expect(lastSaved()).not.toHaveProperty("servingAmount")
    expect(lastSaved()).not.toHaveProperty("servingUnit")
  })

  it("has no button inside the form that submits it", () => {
    newRecipeScreen()

    const form = screen.getByRole("form", { name: "Recipe" })
    const submitters = Array.from(form.querySelectorAll("button")).filter(
      (button) => button.type !== "button"
    )

    expect(submitters.map((button) => button.textContent)).toEqual([])
  })

  it("names the field the backend rejected", async () => {
    saveRecipeAggregate.mockResolvedValue({
      error:
        "Water quantity: Ensure that there are no more than 15 digits in total.",
    })
    const save = newRecipeScreen()

    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Focaccia" },
    })
    fireEvent.click(save)

    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          description:
            "Water quantity: Ensure that there are no more than 15 digits in total.",
          type: "error",
        })
      )
    )
  })
})

describe("the Actions menu before the first save", () => {
  it("offers Import, and holds back what needs a saved recipe", () => {
    render(
      <RecipeChrome title="New recipe" canDelete>
        <RecipeEditor
          currentUserId="user-1"
          initial={null}
          sources={{ items: [], recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
    )

    fireEvent.click(screen.getByRole("button", { name: "Actions" }))

    const disabled = (name: string) =>
      screen.getByRole("menuitem", { name }).getAttribute("aria-disabled")
    expect(disabled("Import recipe…")).not.toBe("true")
    expect(disabled("Share…")).toBe("true")
    expect(disabled("Delete recipe")).toBe("true")
  })

  it("opens the import dialog on a recipe that has never been saved", () => {
    newRecipeScreen()

    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Import recipe…" }))

    expect(screen.getByRole("dialog")).not.toBeNull()
  })
})

describe("the header's Save button", () => {
  it("calls the save the screen registered", () => {
    const save = vi.fn().mockResolvedValue(undefined)
    function Screen() {
      const { registerSave } = useRecipeEdit()
      React.useEffect(() => {
        registerSave(save)
        return () => registerSave(null)
      }, [registerSave])
      return null
    }
    render(
      <RecipeChrome title="New recipe">
        <Screen />
      </RecipeChrome>
    )

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe("saving the prep time", () => {
  it("sends the amount with the unit the cook picked", async () => {
    saveRecipeAggregate.mockResolvedValue({
      id: "rec-3",
      publicId: "ghi789",
      code: "R3",
    })
    const save = newRecipeScreen()
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Brioche" },
    })
    fireEvent.change(screen.getByLabelText("Prep time amount"), {
      target: { value: "45" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Prep time unit" }))
    fireEvent.click(await screen.findByRole("button", { name: "Minutes" }))
    fireEvent.click(save)
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Recipe saved" })
      )
    )

    expect(lastSaved()).toMatchObject({
      prepTimeAmount: 45,
      prepTimeUnit: "minutes",
    })
  })
})

describe("saving the equivalency", () => {
  it("sends a blank family as blank on both sides", async () => {
    saveRecipeAggregate.mockResolvedValue({
      id: "rec-2",
      publicId: "def456",
      code: "R2",
    })
    const save = newRecipeScreen()
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Lemon curd" },
    })
    fireEvent.change(screen.getByLabelText("Weight amount"), {
      target: { value: "700" },
    })
    fireEvent.change(screen.getByLabelText("Each amount"), {
      target: { value: "8" },
    })
    fireEvent.click(save)
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Recipe saved" })
      )
    )
    expect(lastSaved().equivalency).toMatchObject({
      massAmount: 700,
      volumeAmount: null,
      volumeUnit: "",
      countAmount: 8,
    })
    expect(lastSaved().equivalency.massUnit).not.toBe("")
    expect(lastSaved().equivalency.countUnit).not.toBe("")
  })
})

/** A saved recipe whose one line links a sub-recipe nothing has read yet. */
const LINKED = {
  id: "rec-1",
  publicId: "abc123",
  title: "Trifle",
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
  items: [
    {
      id: "line-1",
      kind: "subrecipe",
      position: 0,
      displayName: "Lemon curd",
      quantity: 2,
      unit: "cup",
      preparationNote: "",
      efficiency: 100,
      efficiencyAfterCooking: 100,
      isBase: false,
      excludedFromCost: false,
      ingredientId: null,
      subrecipeId: "rec-curd",
      subrecipe: null,
    },
  ],
  steps: [],
  equivalency: null,
  tags: [],
  comments: [],
  ingredientOptions: [],
  recipeOptions: [],
} as unknown as RecipeDetail

describe("the Save button over a recipe someone else owns", () => {
  /** The chrome starts a shared recipe with no Save of its own; the editor
   *  under it is the one that says whether there is anything to register. */
  function sharedRecipeScreen(canEdit: boolean) {
    render(
      <RecipeChrome id="rec-1" title="Trifle" publicId="abc123" canEdit={false}>
        <RecipeEditor
          currentUserId="user-2"
          initial={
            {
              ...LINKED,
              permission: canEdit ? "editor" : "viewer",
              canEdit,
              items: [],
            } as unknown as RecipeDetail
          }
          sources={{ items: [], recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
    )
  }

  it("is there for a kitchen editor", () => {
    sharedRecipeScreen(true)
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined()
  })

  it("is never drawn for a viewer", () => {
    sharedRecipeScreen(false)
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
  })

  it("sends stable line identities without restating the owner's cost exclusion", async () => {
    saveRecipeAggregate.mockResolvedValue({
      id: "rec-1",
      publicId: "abc123",
      editVersion: 2,
    })
    render(
      <RecipeChrome id="rec-1" title="Trifle" publicId="abc123" canEdit={false}>
        <RecipeEditor
          currentUserId="user-2"
          initial={{
            ...LINKED,
            permission: "editor",
            items: [{ ...LINKED.items[0], excludedFromCost: true }],
          }}
          sources={{ items: [], recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveRecipeAggregate).toHaveBeenCalled())
    expect(lastSaved().items[0].id).toBe(LINKED.items[0].id)
    expect(lastSaved().items[0]).not.toHaveProperty("excludedFromCost")
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Recipe saved" })
      )
    )
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Trifle tomorrow" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(lastSaved().title).toBe("Trifle tomorrow"))
    expect(lastSaved().items[0].id).toBe(LINKED.items[0].id)
  })
})

describe("a sub-recipe linked in this session", () => {
  it("expands without a reload once the save answers with its lines", async () => {
    saveRecipeAggregate.mockResolvedValue({
      id: "rec-1",
      publicId: "abc123",
      code: "R1",
      items: [
        {
          ...LINKED.items[0],
          subrecipe: {
            id: "rec-curd",
            publicId: "rcp_curd",
            title: "Lemon curd",
            yieldAmount: 2,
            yieldUnit: "cup",
            items: [],
          },
        },
      ],
    })
    render(
      <RecipeChrome id={LINKED.id} publicId={LINKED.publicId} title="Trifle">
        <RecipeEditor
          currentUserId="user-1"
          initial={LINKED}
          sources={{ items: [], recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
    )
    expect(screen.queryByRole("button", { name: "Show sub-recipe" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show sub-recipe" })
      ).not.toBeNull()
    )
  })
})
