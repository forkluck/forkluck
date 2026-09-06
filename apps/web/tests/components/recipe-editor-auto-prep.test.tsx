// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const saveRecipeAggregate = vi.fn()

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

vi.mock("next/navigation", () => ({
  usePathname: () => "/recipes/rec-1/recipe",
  useSearchParams: () => new URLSearchParams(),
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

import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome } from "@/components/recipes/recipe-chrome"
import type { RecipeDetail } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  saveRecipeAggregate.mockReset()
})

function step(
  id: string,
  laborKind: "" | "active" | "passive",
  seconds: number | null
) {
  return {
    id,
    kind: "instruction",
    title: "",
    body: id,
    laborKind,
    timings:
      seconds === null ? [] : [{ id: `${id}-t`, seconds, yieldCount: 1 }],
    media: [],
  }
}

/** A saved recipe, which is all the editor reads of one. */
function saved(steps: ReturnType<typeof step>[]): RecipeDetail {
  return {
    id: "rec-1",
    publicId: "abc123",
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
    prepTimeAmount: null,
    prepTimeUnit: "",
    autoSumYieldEnabled: false,
    autoPrepTimeEnabled: false,
    percentageMode: "",
    percentIngredientEnabled: false,
    percentIngredientType: "",
    items: [],
    steps,
    equivalency: null,
    tags: [],
    comments: [],
    ingredientOptions: [],
    recipeOptions: [],
  } as unknown as RecipeDetail
}

function editorScreen(steps: ReturnType<typeof step>[]) {
  render(
    <RecipeChrome id="rec-1" publicId="abc123" title="Focaccia">
      <RecipeEditor
        currentUserId="user-1"
        initial={saved(steps)}
        sources={{ items: [], recipes: [] }}
        categoryOptions={[]}
        tagOptions={[]}
      />
    </RecipeChrome>
  )
}

function autoPrep() {
  fireEvent.click(
    screen.getByRole("switch", { name: /Auto-calculate from steps/ })
  )
}

function prepAmount() {
  return screen.getByLabelText("Prep time amount") as HTMLInputElement
}

/** What the last save sent. */
function lastSaved() {
  return saveRecipeAggregate.mock.calls.at(-1)?.[0]
}

async function save() {
  saveRecipeAggregate.mockResolvedValue({
    id: "rec-1",
    publicId: "abc123",
    code: "R1",
  })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await vi.waitFor(() => expect(saveRecipeAggregate).toHaveBeenCalled())
}

describe("prep time calculated from the steps", () => {
  it("adds up the active steps and locks the amount", () => {
    editorScreen([step("mix", "active", 600), step("shape", "active", 300)])

    autoPrep()

    expect(prepAmount().value).toBe("15")
    expect(prepAmount().disabled).toBe(true)
    // The unit stays the cook's to change.
    expect(
      (
        screen.getByRole("button", {
          name: "Prep time unit",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  it("leaves out the steps nobody times or works", () => {
    editorScreen([
      step("mix", "active", 600),
      step("rest", "passive", 3600),
      step("pack", "active", null),
    ])

    autoPrep()

    expect(prepAmount().value).toBe("10")
  })

  it("reads a whole number of hours as hours", async () => {
    editorScreen([step("mix", "active", 7200)])

    autoPrep()
    expect(prepAmount().value).toBe("2")
    await save()

    expect(lastSaved()).toMatchObject({
      prepTimeAmount: 2,
      prepTimeUnit: "hours",
    })
  })

  it("is disabled and says so when no step is timed", () => {
    editorScreen([step("pack", "active", null)])

    expect(
      screen
        .getByRole("switch", { name: /Auto-calculate from steps/ })
        .getAttribute("data-disabled")
    ).not.toBeNull()
    expect(prepAmount().value).toBe("")
  })

  it("brings back the typed prep time once it is off", () => {
    editorScreen([step("mix", "active", 600)])
    fireEvent.change(prepAmount(), { target: { value: "45" } })

    autoPrep()
    expect(prepAmount().value).toBe("10")

    autoPrep()

    expect(prepAmount().value).toBe("45")
    expect(prepAmount().disabled).toBe(false)
  })

  it("saves the switch and the time it worked out", async () => {
    editorScreen([step("mix", "active", 600)])

    autoPrep()
    await save()

    expect(lastSaved()).toMatchObject({
      autoPrepTimeEnabled: true,
      prepTimeAmount: 10,
      prepTimeUnit: "minutes",
    })
  })
})

describe("a step's hands-on time", () => {
  function openLabor() {
    fireEvent.click(screen.getByRole("button", { name: "Time for step 1" }))
  }

  /** The header is behind the dialog until it closes. */
  function done() {
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
  }

  it("saves one timing for one batch", async () => {
    editorScreen([step("mix", "active", null)])
    openLabor()

    fireEvent.change(screen.getByLabelText("Time amount"), {
      target: { value: "10" },
    })
    done()
    await save()

    expect(lastSaved().steps[0]).toMatchObject({
      timings: [{ seconds: 600, yieldCount: 1 }],
    })
  })

  it("reads the time it already has back into the field", () => {
    editorScreen([step("mix", "active", 900)])

    openLabor()

    expect(
      (screen.getByLabelText("Time amount") as HTMLInputElement).value
    ).toBe("15")
  })

  it("clears the timing when the time is emptied", async () => {
    editorScreen([step("mix", "active", 900)])
    openLabor()

    fireEvent.change(screen.getByLabelText("Time amount"), {
      target: { value: "" },
    })
    done()
    await save()

    expect(lastSaved().steps[0]).toMatchObject({ timings: [] })
  })
})
