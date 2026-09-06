// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import {
  activateCatalogIngredient,
  saveIngredient,
  searchCatalogIngredients,
} from "@/app/(app)/ingredients/actions"
import { saveRecipe } from "@/app/(app)/recipes/actions"
import {
  RecipeItemsTable,
  type RecipeItemKind,
  type RecipeItemState,
  type Subrecipe,
} from "@/components/recipes/recipe-items-table"

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(),
  activateCatalogIngredient: vi.fn(),
  saveIngredient: vi.fn(),
  savePreparation: vi.fn(),
}))
vi.mock("@/app/(app)/recipes/actions", () => ({
  saveRecipe: vi.fn(),
}))

const searchMock = vi.mocked(searchCatalogIngredients)
const saveIngredientMock = vi.mocked(saveIngredient)
const saveRecipeMock = vi.mocked(saveRecipe)
const activateMock = vi.mocked(activateCatalogIngredient)

beforeEach(() => {
  vi.clearAllMocks()
  searchMock.mockResolvedValue({
    items: [
      {
        id: "cat-1",
        name: "Carrots",
        preparations: ["chopped"],
        aliases: [],
      },
    ],
  })
  activateMock.mockResolvedValue({
    id: "pantry-1",
    name: "Carrots",
    created: true,
    preparations: ["chopped"],
  })
})

afterEach(cleanup)

function item(partial: Partial<RecipeItemState>): RecipeItemState {
  return {
    key: "row-1",
    kind: "ingredient",
    displayName: "Sugar",
    quantity: "1",
    unit: "cup",
    preparationNote: "",
    efficiency: "100",
    efficiencyAfterCooking: "100",
    isBase: false,
    excludedFromCost: false,
    ingredientId: null,
    subrecipeId: null,
    ...partial,
  }
}

function Harness({
  initial,
  targets = [],
  canEdit = true,
  recipes = [],
  onAddSteps,
}: {
  initial: RecipeItemState[]
  targets?: {
    id: string
    name: string
    preparations?: string[]
    nonEdible?: boolean
  }[]
  canEdit?: boolean
  recipes?: { id: string; publicId?: string; title: string }[]
  onAddSteps?: (text: string) => void
}) {
  const [items, setItems] = React.useState(initial)
  const [ingredientTargets, setIngredientTargets] = React.useState<
    {
      id: string
      name: string
      preparations?: string[]
      nonEdible?: boolean
    }[]
  >(targets)
  const next = React.useRef(0)
  return (
    <>
      <RecipeItemsTable
        items={items}
        canEdit={canEdit}
        recipeId={null}
        ingredientTargets={ingredientTargets}
        onIngredientActivated={(row) =>
          setIngredientTargets((current) => [...current, row])
        }
        recipeTargets={recipes}
        onOpenImport={() => {}}
        onAddSteps={onAddSteps}
        onPatch={(key, patch) =>
          setItems((current) =>
            current.map((one) => (one.key === key ? { ...one, ...patch } : one))
          )
        }
        onReorder={(from, to) =>
          setItems((current) => {
            const copy = [...current]
            const [moved] = copy.splice(from, 1)
            copy.splice(to, 0, moved)
            return copy
          })
        }
        onRemove={(key) =>
          setItems((current) => current.filter((one) => one.key !== key))
        }
        onAdd={(kind: RecipeItemKind, partial, afterKey) => {
          next.current += 1
          const key = `added-${next.current}`
          const row = item({
            key,
            kind,
            displayName: "",
            quantity: kind === "ingredient" ? "1" : "",
            unit: kind === "ingredient" ? "each" : "",
            ...partial,
          })
          setItems((current) => {
            const at = afterKey
              ? current.findIndex((one) => one.key === afterKey)
              : -1
            if (at === -1) return [...current, row]
            return [...current.slice(0, at + 1), row, ...current.slice(at + 1)]
          })
          return key
        }}
        percentMode={false}
        percentageMode=""
        onPercentageModeChange={() => {}}
        onSetBase={() => {}}
        onPercentModeChange={() => {}}
      />
      <output data-testid="order">
        {items.map((one) => `${one.kind}:${one.quantity}`).join("|")}
      </output>
      <output data-testid="rows">
        {items
          .map(
            (one) =>
              `${one.displayName}/${one.preparationNote}/${one.ingredientId}`
          )
          .join("|")}
      </output>
      <output data-testid="links">
        {items.map((one) => `${one.kind}:${one.subrecipeId}`).join("|")}
      </output>
      <output data-testid="targets">
        {ingredientTargets.map((one) => one.name).join("|")}
      </output>
    </>
  )
}

async function quickAddLine(text: string) {
  const quickAdd = screen.getByLabelText("Quick add ingredient")
  fireEvent.change(quickAdd, { target: { value: text } })
  fireEvent.keyDown(quickAdd, { key: "Enter" })
  await act(async () => {})
}

function quantityInputs() {
  return screen.getAllByLabelText("Quantity") as HTMLInputElement[]
}

describe("recipe items table quantities", () => {
  it("shows a stored decimal as a kitchen fraction until it is focused", () => {
    render(<Harness initial={[item({ quantity: "0.25" })]} />)
    const input = quantityInputs()[0]
    expect(input.value).toBe("1/4")
    fireEvent.focus(input)
    expect(input.value).toBe("0.25")
  })

  it("parses a typed fraction on blur", () => {
    render(<Harness initial={[item({ quantity: "1" })]} />)
    const input = quantityInputs()[0]
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "1 1/2" } })
    fireEvent.blur(input)
    expect(screen.getByTestId("order").textContent).toBe("ingredient:1.5")
    expect(quantityInputs()[0].value).toBe("1 1/2")
  })

  it("keeps a large quantity whole", () => {
    render(<Harness initial={[item({ quantity: "1" })]} />)
    const input = quantityInputs()[0]
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "225" } })
    fireEvent.blur(input)
    expect(screen.getByTestId("order").textContent).toBe("ingredient:225")
    expect(quantityInputs()[0].value).toBe("225")
  })

  it("rounds a repeating fraction to six decimals", () => {
    render(<Harness initial={[item({ quantity: "1" })]} />)
    const input = quantityInputs()[0]
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "1 1/3" } })
    fireEvent.blur(input)
    expect(screen.getByTestId("order").textContent).toBe("ingredient:1.333333")
  })

  it("allows a blank quantity for an unmeasured row", () => {
    render(<Harness initial={[item({ quantity: "1" })]} />)
    const input = quantityInputs()[0]
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)
    expect(screen.getByTestId("order").textContent).toBe("ingredient:")
    expect(quantityInputs()[0].value).toBe("")
  })
})

describe("recipe items table rows", () => {
  it("gives every row a drag handle", () => {
    const { container } = render(
      <Harness
        initial={[item({ key: "a" }), item({ key: "b", displayName: "Salt" })]}
      />
    )
    expect(container.querySelectorAll("[data-drag-handle]")).toHaveLength(2)
    expect(container.querySelectorAll("[data-sortable-row]")).toHaveLength(2)
  })

  it("inserts a header after the row being worked on", async () => {
    render(
      <Harness
        initial={[
          item({ key: "a", quantity: "1" }),
          item({ key: "b", quantity: "2" }),
          item({ key: "c", quantity: "3" }),
        ]}
      />
    )
    fireEvent.focus(quantityInputs()[0])
    const quickAdd = screen.getByLabelText("Quick add ingredient")
    fireEvent.change(quickAdd, { target: { value: "# Filling" } })
    fireEvent.keyDown(quickAdd, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByTestId("order").textContent).toBe(
        "ingredient:1|header:|ingredient:2|ingredient:3"
      )
    )
    expect(screen.getByTestId("rows").textContent).toContain("Filling//null")
    fireEvent.change(quickAdd, { target: { value: "> chill overnight" } })
    fireEvent.keyDown(quickAdd, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByTestId("order").textContent).toBe(
        "ingredient:1|header:|note:|ingredient:2|ingredient:3"
      )
    )
  })

  it("inserts a quick-add ingredient after the row being worked on", async () => {
    render(
      <Harness
        initial={[
          item({ key: "a", quantity: "1" }),
          item({ key: "b", quantity: "2" }),
        ]}
      />
    )
    fireEvent.focus(quantityInputs()[0])
    await quickAddLine("1 1/3 cups water")
    expect(screen.getByTestId("order").textContent).toBe(
      "ingredient:1|ingredient:1.333333|ingredient:2"
    )
  })
})

describe("pasting a list into the quick add field", () => {
  const paste = (text: string) => {
    const field = screen.getByLabelText("Quick add ingredient")
    fireEvent.paste(field, { clipboardData: { getData: () => text } })
    return field as HTMLInputElement
  }

  it("adds the last line too, with no newline after it", async () => {
    searchMock.mockResolvedValue({ items: [] })
    render(<Harness initial={[]} />)

    const field = paste("250 g flour\n10 g salt\n1 egg yolk")
    await act(async () => {})

    expect(screen.getByTestId("order").textContent).toBe(
      "ingredient:250|ingredient:10|ingredient:1"
    )
    expect(field.value).toBe("")
  })

  it("reads a list broken the way a spreadsheet breaks it", async () => {
    searchMock.mockResolvedValue({ items: [] })
    render(<Harness initial={[]} />)

    paste("250 g flour\r10 g salt\r1 egg yolk")
    await act(async () => {})

    expect(screen.getByTestId("order").textContent).toBe(
      "ingredient:250|ingredient:10|ingredient:1"
    )
  })

  it("keeps the line already typed in the field", async () => {
    searchMock.mockResolvedValue({ items: [] })
    render(<Harness initial={[]} />)
    const field = screen.getByLabelText(
      "Quick add ingredient"
    ) as HTMLInputElement
    fireEvent.change(field, { target: { value: "1 egg yolk" } })
    field.setSelectionRange(10, 10)

    fireEvent.paste(field, {
      clipboardData: { getData: () => "\n250 g flour\n10 g salt" },
    })
    await act(async () => {})

    expect(screen.getByTestId("order").textContent).toBe(
      "ingredient:1|ingredient:250|ingredient:10"
    )
  })

  it("leaves a single typed line pending until it is entered", () => {
    render(<Harness initial={[]} />)
    const field = screen.getByLabelText(
      "Quick add ingredient"
    ) as HTMLInputElement
    fireEvent.change(field, { target: { value: "1 egg yolk" } })

    expect(screen.getByTestId("order").textContent).toBe("")
    expect(field.value).toBe("1 egg yolk")
  })
})

describe("pasting a whole recipe into the quick add field", () => {
  it("keeps the list here and hands the method to the steps", async () => {
    const addSteps = vi.fn()
    render(<Harness initial={[]} onAddSteps={addSteps} />)

    fireEvent.paste(screen.getByLabelText("Quick add ingredient"), {
      clipboardData: {
        getData: () =>
          "250 g flour\n10 g salt\nMethod:\nMix it well.\nBake it.",
      },
    })
    await act(async () => {})

    expect(screen.getByTestId("order").textContent).toBe(
      "ingredient:250|ingredient:10"
    )
    expect(addSteps).toHaveBeenCalledWith("Mix it well.\nBake it.")
  })
})

function openPicker(value: string) {
  const field = screen.getAllByLabelText("Ingredient or recipe")[0]
  fireEvent.focus(field)
  fireEvent.change(field, { target: { value } })
  return field
}

describe("recipe items table catalog picker", () => {
  it("opens a filled field on its own name, current ingredient first", async () => {
    render(
      <Harness
        initial={[item({ displayName: "Olive oil", ingredientId: "pantry-2" })]}
        targets={[
          { id: "pantry-1", name: "Lemon olive oil" },
          { id: "pantry-2", name: "Olive oil" },
        ]}
      />
    )
    const field = screen.getAllByLabelText("Ingredient or recipe")[0]
    fireEvent.focus(field)
    expect(screen.getAllByRole("option").map((one) => one.textContent)).toEqual(
      ["Olive oil", "Lemon olive oil"]
    )
    fireEvent.blur(field)
    expect(screen.getByTestId("rows").textContent).toBe("Olive oil//pantry-2")
  })

  it("does not suggest a supply", () => {
    render(
      <Harness
        initial={[item({ displayName: "Olive oil", ingredientId: "pantry-2" })]}
        targets={[
          { id: "pantry-2", name: "Olive oil" },
          { id: "sup-1", name: "Olive oil bottle", nonEdible: true },
        ]}
      />
    )
    fireEvent.focus(screen.getAllByLabelText("Ingredient or recipe")[0])
    expect(screen.getAllByRole("option").map((one) => one.textContent)).toEqual(
      ["Olive oil"]
    )
  })

  it("keeps a line already on a supply", () => {
    render(
      <Harness
        initial={[item({ displayName: "Takeout box", ingredientId: "sup-1" })]}
        targets={[
          { id: "pantry-2", name: "Olive oil" },
          { id: "sup-1", name: "Takeout box", nonEdible: true },
        ]}
      />
    )
    fireEvent.focus(screen.getAllByLabelText("Ingredient or recipe")[0])
    expect(screen.getAllByRole("option").map((one) => one.textContent)).toEqual(
      ["Takeout box"]
    )
  })

  it("shows nothing until something is typed", () => {
    render(
      <Harness
        initial={[item({ displayName: "" })]}
        targets={[{ id: "pantry-9", name: "Carrot cake mix" }]}
      />
    )
    fireEvent.focus(screen.getAllByLabelText("Ingredient or recipe")[0])
    expect(screen.queryByRole("listbox")).toBeNull()
    fireEvent.focus(screen.getByLabelText("Quick add ingredient"))
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("lists the pantry before the catalog", async () => {
    render(
      <Harness
        initial={[item({ displayName: "" })]}
        targets={[{ id: "pantry-9", name: "Carrot cake mix" }]}
      />
    )
    openPicker("carr")
    await screen.findAllByText("Catalog")
    const options = screen.getAllByRole("option").map((one) => one.textContent)
    expect(options).toEqual(["Carrot cake mix", "CarrotsCatalog", "chopped"])
  })

  it("keeps owned results visible without narrating the catalog search", async () => {
    vi.useFakeTimers()
    try {
      render(
        <Harness
          initial={[item({ displayName: "" })]}
          targets={[{ id: "pantry-9", name: "Carrot cake mix" }]}
        />
      )
      openPicker("carr")

      expect(screen.queryByText("Searching…")).toBeNull()
      expect(
        screen.getAllByRole("option").map((one) => one.textContent)
      ).toEqual(["Carrot cake mix"])

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })

      expect(
        screen.getAllByRole("option").map((one) => one.textContent)
      ).toEqual(["Carrot cake mix", "CarrotsCatalog", "chopped"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves nothing behind when the catalog has no answer", async () => {
    searchMock.mockResolvedValue({ items: [] })
    vi.useFakeTimers()
    try {
      render(<Harness initial={[item({ displayName: "" })]} />)
      openPicker("carr")
      expect(screen.queryByText("Searching…")).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })

      expect(screen.queryAllByRole("option")).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("names the synonym a catalog card was found under", async () => {
    searchMock.mockResolvedValue({
      items: [
        {
          id: "cat-2",
          name: "Powdered sugar",
          preparations: [],
          aliases: ["confectioners sugar", "icing sugar"],
        },
      ],
    })
    render(<Harness initial={[item({ displayName: "" })]} />)
    openPicker("confectioners sugar")
    await screen.findAllByText("Catalog")
    expect(screen.getByText("confectioners sugar").className).toContain(
      "text-muted-foreground"
    )
    expect(screen.getAllByRole("option")[0].textContent).toBe(
      "Powdered sugarconfectioners sugarCatalog"
    )
  })

  it("says nothing extra when the card's own name was typed", async () => {
    searchMock.mockResolvedValue({
      items: [
        {
          id: "cat-2",
          name: "Powdered sugar",
          preparations: [],
          aliases: ["confectioners sugar"],
        },
      ],
    })
    render(<Harness initial={[item({ displayName: "" })]} />)
    openPicker("powdered sugar")
    await screen.findAllByText("Catalog")
    expect(screen.queryByText("confectioners sugar")).toBeNull()
  })

  it("activates a catalog pick and grows the target list", async () => {
    render(<Harness initial={[item({ displayName: "" })]} />)
    openPicker("carr")
    await screen.findAllByText("Catalog")
    fireEvent.click(screen.getAllByRole("option")[0])
    await screen.findByText("Carrots//pantry-1")
    expect(activateMock).toHaveBeenCalledWith("cat-1")
    expect(screen.getByTestId("targets").textContent).toBe("Carrots")
  })

  it("lists a pantry ingredient's preparations under it, and picks one", async () => {
    render(
      <Harness
        initial={[item({ displayName: "" })]}
        targets={[{ id: "pantry-9", name: "Carrot", preparations: ["diced"] }]}
      />
    )
    openPicker("carr")
    await screen.findAllByText("Catalog")
    expect(screen.getAllByRole("option").map((one) => one.textContent)).toEqual(
      ["Carrot", "diced", "CarrotsCatalog", "chopped"]
    )
    fireEvent.click(screen.getByRole("option", { name: "Carrot, diced" }))
    await screen.findByText("Carrot/diced/pantry-9")
  })

  it("writes the preparation of a catalog preparation row to the notes", async () => {
    render(<Harness initial={[item({ displayName: "" })]} />)
    openPicker("carr")
    await screen.findAllByText("Catalog")
    fireEvent.click(screen.getAllByRole("option")[1])
    await screen.findByText("Carrots/chopped/pantry-1")
  })

  it("picks the arrowed-to row on Enter", async () => {
    render(<Harness initial={[item({ displayName: "" })]} />)
    const field = openPicker("carr")
    await screen.findAllByText("Catalog")
    fireEvent.keyDown(field, { key: "ArrowDown" })
    fireEvent.keyDown(field, { key: "ArrowDown" })
    fireEvent.keyDown(field, { key: "Enter" })
    await screen.findByText("Carrots/chopped/pantry-1")
  })

  it("closes the list on Escape", async () => {
    render(<Harness initial={[item({ displayName: "" })]} />)
    const field = openPicker("carr")
    await screen.findAllByText("Catalog")
    fireEvent.keyDown(field, { key: "Escape" })
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("keeps a name the catalog does not know to the create options", async () => {
    searchMock.mockResolvedValue({ items: [] })
    render(<Harness initial={[item({ displayName: "" })]} />)
    openPicker("nduja")
    await screen.findByText("Add ingredient")
    // Entry offers what moves the recipe forward; the mailto is gone.
    expect(screen.queryByRole("link")).toBeNull()
  })
})

describe("recipe items table typos", () => {
  it("offers the pantry row a typo was aiming at", () => {
    searchMock.mockResolvedValue({ items: [] })
    render(
      <Harness
        initial={[item({ displayName: "" })]}
        targets={[{ id: "pantry-1", name: "Garlic" }]}
      />
    )
    openPicker("jarlic")
    expect(screen.getAllByRole("option").map((one) => one.textContent)).toEqual(
      ["Garlic"]
    )
  })
})

describe("recipe items table creating from the picker", () => {
  it("adds a typed name as a new ingredient and links the line", async () => {
    searchMock.mockResolvedValue({ items: [] })
    saveIngredientMock.mockResolvedValue({
      id: "pantry-new",
      publicId: "ing_1",
      editVersion: 0,
    })
    render(<Harness initial={[item({ displayName: "" })]} />)
    openPicker("popo")
    fireEvent.click(
      await screen.findByRole("button", { name: "Add ingredient" })
    )
    await screen.findByText("popo//pantry-new")
    expect(saveIngredientMock).toHaveBeenCalledWith({
      id: null,
      name: "popo",
      purchaseCostCents: 0,
      purchaseSize: null,
      purchaseUnit: null,
    })
    expect(screen.getByTestId("targets").textContent).toBe("popo")
  })

  it("keeps the quick-add to what exists, and waits for a name", () => {
    searchMock.mockResolvedValue({ items: [] })
    render(<Harness initial={[]} />)
    const quickAdd = screen.getByLabelText("Quick add ingredient")
    fireEvent.focus(quickAdd)
    fireEvent.change(quickAdd, { target: { value: "1 cup" } })
    expect(screen.queryByRole("listbox")).toBeNull()
    fireEvent.change(quickAdd, { target: { value: "1 cup popo" } })
    expect(screen.queryByRole("button", { name: "Add ingredient" })).toBeNull()
  })

  it("never offers to create a preparation, even on a linked line", async () => {
    searchMock.mockResolvedValue({ items: [] })
    render(
      <Harness
        initial={[item({ displayName: "Garlic", ingredientId: "pantry-1" })]}
        targets={[{ id: "pantry-1", name: "Garlic", preparations: ["minced"] }]}
      />
    )
    const field = screen.getAllByLabelText("Ingredient or recipe")[0]
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "microplaned" } })
    await screen.findByRole("button", { name: "Add ingredient" })
    expect(screen.queryByRole("button", { name: "Add preparation" })).toBeNull()
  })

  it("keeps the Free-plan limit dialog when creating a recipe", async () => {
    searchMock.mockResolvedValue({ items: [] })
    saveRecipeMock.mockResolvedValue({
      error: "The Free plan includes up to 25 recipes.",
      code: "recipe_limit_reached",
    })
    render(<Harness initial={[item({ displayName: "" })]} />)
    openPicker("babka filling")
    fireEvent.click(await screen.findByRole("button", { name: "Add recipe" }))
    expect(
      await screen.findByRole("heading", { name: "Recipe limit reached" })
    ).toBeTruthy()
    expect(
      screen.getByText("The Free plan includes up to 25 recipes.")
    ).toBeTruthy()
  })

  it("does not offer to create what already exists", async () => {
    render(
      <Harness
        initial={[item({ displayName: "" })]}
        targets={[{ id: "pantry-1", name: "Garlic" }]}
      />
    )
    openPicker("garlic")
    expect(screen.queryByRole("button", { name: "Add ingredient" })).toBeNull()
  })
})

describe("recipe items table unlinked lines", () => {
  it("marks a line linked to nothing on the field, and the mark opens its picker", () => {
    render(
      <Harness
        initial={[
          item({ key: "a", displayName: "popo" }),
          item({ key: "b", displayName: "Carrot", ingredientId: "pantry-1" }),
        ]}
      />
    )
    const marks = screen.getAllByRole("button", {
      name: "Not linked: pick an ingredient or recipe",
    })
    expect(marks).toHaveLength(1)
    fireEvent.click(marks[0])
    expect(document.activeElement).toBe(
      screen.getAllByLabelText("Ingredient or recipe")[0]
    )
  })
})

describe("recipe items table composed preparations", () => {
  const almond = [
    { id: "pantry-almond", name: "Almond", preparations: ["sliced"] },
  ]

  function field() {
    return screen.getAllByLabelText(
      "Ingredient or recipe"
    )[0] as HTMLInputElement
  }

  beforeEach(() => searchMock.mockResolvedValue({ items: [] }))

  it("reads a saved preparation in the ingredient field, not the notes", () => {
    render(
      <Harness
        initial={[
          item({
            displayName: "Almond",
            ingredientId: "pantry-almond",
            preparationNote: "sliced",
          }),
        ]}
        targets={almond}
      />
    )
    expect(field().value).toBe("Almond, sliced")
    expect((screen.getByLabelText("Notes") as HTMLInputElement).value).toBe("")
  })

  it("edits the rest of the note and writes the preparation back in front", () => {
    render(
      <Harness
        initial={[
          item({
            displayName: "Almond",
            ingredientId: "pantry-almond",
            preparationNote: "sliced, room temperature",
          }),
        ]}
        targets={almond}
      />
    )
    const notes = screen.getByLabelText("Notes") as HTMLInputElement
    expect(notes.value).toBe("room temperature")
    fireEvent.change(notes, { target: { value: "toasted" } })
    expect(screen.getByTestId("rows").textContent).toBe(
      "Almond/sliced, toasted/pantry-almond"
    )
  })

  it("keeps the preparation when the rest of the note is cleared", () => {
    render(
      <Harness
        initial={[
          item({
            displayName: "Almond",
            ingredientId: "pantry-almond",
            preparationNote: "sliced, toasted",
          }),
        ]}
        targets={almond}
      />
    )
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "" } })
    expect(screen.getByTestId("rows").textContent).toBe(
      "Almond/sliced/pantry-almond"
    )
  })

  it("finds the preparation row for a name typed out in full", () => {
    render(<Harness initial={[item({ displayName: "" })]} targets={almond} />)
    openPicker("almond, sliced")
    expect(screen.getAllByRole("option").map((one) => one.textContent)).toEqual(
      ["Almond", "sliced"]
    )
  })

  it("attaches a name and preparation typed out in full on blur", () => {
    render(<Harness initial={[item({ displayName: "" })]} targets={almond} />)
    const input = openPicker("almond, sliced")
    fireEvent.blur(input)
    expect(screen.getByTestId("rows").textContent).toBe(
      "Almond/sliced/pantry-almond"
    )
  })

  it("marks a linked line whose extra words name no preparation", () => {
    render(
      <Harness
        initial={[
          item({
            displayName: "Almond, crushed",
            ingredientId: "pantry-almond",
          }),
        ]}
        targets={almond}
      />
    )
    expect(
      screen.getAllByRole("button", {
        name: "Not a saved preparation: pick one from the list",
      })
    ).toHaveLength(1)
  })
})

describe("recipe items table quick add", () => {
  it("keeps rapid entries in submission order while catalog lookup waits", async () => {
    let finishFirst!: (value: { items: never[] }) => void
    const firstSearch = new Promise<{ items: never[] }>((resolve) => {
      finishFirst = resolve
    })
    searchMock.mockImplementation((query) =>
      query === "First ingredient"
        ? firstSearch
        : Promise.resolve({ items: [] })
    )
    render(<Harness initial={[]} />)
    const quickAdd = screen.getByLabelText("Quick add ingredient")

    fireEvent.change(quickAdd, {
      target: { value: "1 each First ingredient" },
    })
    fireEvent.keyDown(quickAdd, { key: "Enter" })
    fireEvent.change(quickAdd, {
      target: { value: "2 each Second ingredient" },
    })
    fireEvent.keyDown(quickAdd, { key: "Enter" })
    fireEvent.change(quickAdd, { target: { value: "# Seasoning" } })
    fireEvent.keyDown(quickAdd, { key: "Enter" })

    await waitFor(() =>
      expect(searchMock).toHaveBeenCalledWith("First ingredient")
    )
    expect(searchMock).not.toHaveBeenCalledWith("Second ingredient")
    finishFirst({ items: [] })

    await waitFor(() =>
      expect(screen.getByTestId("rows").textContent).toBe(
        "First ingredient//null|Second ingredient//null|Seasoning//null"
      )
    )
    expect(screen.getByTestId("order").textContent).toBe(
      "ingredient:1|ingredient:2|header:"
    )
  })

  it("names ingredients only, never their preparations", async () => {
    render(
      <Harness
        initial={[]}
        targets={[{ id: "pantry-9", name: "Carrot", preparations: ["diced"] }]}
      />
    )
    const quickAdd = screen.getByLabelText("Quick add ingredient")
    fireEvent.focus(quickAdd)
    fireEvent.change(quickAdd, { target: { value: "2 cups carr" } })
    await screen.findAllByText("Catalog")
    expect(screen.getAllByRole("option").map((one) => one.textContent)).toEqual(
      ["Carrot", "CarrotsCatalog"]
    )
  })

  it("adds the line from the button as well as Enter", async () => {
    render(<Harness initial={[]} />)
    fireEvent.change(screen.getByLabelText("Quick add ingredient"), {
      target: { value: "2 cups onion" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add line" }))
    await act(async () => {})
    expect(screen.getByTestId("order").textContent).toBe("ingredient:2")
  })

  it("keeps the parsed qualifier as the note", async () => {
    render(<Harness initial={[]} />)
    await quickAddLine("250 g cake flour, sifted")
    expect(screen.getByTestId("rows").textContent).toBe(
      "cake flour/sifted/null"
    )
  })

  it.each([
    "almond sliced",
    "tomato diced",
    "coconut shredded",
    "sliced almond",
  ])("keeps the bare phrase %s as the ingredient identity", async (name) => {
    searchMock.mockResolvedValue({ items: [] })
    render(<Harness initial={[]} />)

    await quickAddLine(`50 g ${name}`)

    expect(screen.getByTestId("rows").textContent).toBe(`${name}//null`)
  })

  it("does not turn a bare phrase into a saved preparation", async () => {
    searchMock.mockResolvedValue({ items: [] })
    render(
      <Harness
        initial={[]}
        targets={[
          { id: "pantry-almond", name: "Almond", preparations: ["sliced"] },
        ]}
      />
    )

    await quickAddLine("50 g sliced almond")

    expect(screen.getByTestId("rows").textContent).toBe("sliced almond//null")
  })

  it("links the complete bare phrase when that ingredient exists", async () => {
    render(
      <Harness
        initial={[]}
        targets={[{ id: "pantry-almond", name: "Almond Sliced" }]}
      />
    )

    await quickAddLine("50 g almond sliced")

    expect(screen.getByTestId("rows").textContent).toBe(
      "Almond Sliced//pantry-almond"
    )
  })

  it("moves a comma-delimited preparation into the note", async () => {
    searchMock.mockResolvedValue({ items: [] })
    render(<Harness initial={[]} />)

    await quickAddLine("50 g almond, sliced")

    expect(screen.getByTestId("rows").textContent).toBe("almond/sliced/null")
  })

  it("leaves a name nothing knows unlinked", async () => {
    searchMock.mockResolvedValue({ items: [] })
    render(<Harness initial={[]} />)
    await quickAddLine("2 cups popo")
    expect(screen.getByTestId("rows").textContent).toBe("popo//null")
    expect(activateMock).not.toHaveBeenCalled()
  })

  it("searches the catalog on the bare name for an explicit qualifier", async () => {
    render(<Harness initial={[]} />)
    const quickAdd = screen.getByLabelText("Quick add ingredient")
    fireEvent.focus(quickAdd)
    fireEvent.change(quickAdd, { target: { value: "2 cups carr, chopped" } })
    await screen.findAllByText("Catalog")
    expect(searchMock).toHaveBeenCalledWith("carr")
  })

  it("takes the highlighted catalog row and keeps the parsed amount", async () => {
    render(<Harness initial={[]} />)
    const quickAdd = screen.getByLabelText("Quick add ingredient")
    fireEvent.focus(quickAdd)
    fireEvent.change(quickAdd, { target: { value: "2 cups carrots" } })
    await screen.findAllByText("Catalog")
    fireEvent.keyDown(quickAdd, { key: "ArrowDown" })
    fireEvent.keyDown(quickAdd, { key: "Enter" })
    await screen.findByText("Carrots//pantry-1")
    expect(screen.getByTestId("order").textContent).toBe("ingredient:2")
  })
})

function curd(partial: Partial<Subrecipe> = {}): Subrecipe {
  return {
    id: "recipe-9",
    publicId: "rcp_lemoncurd",
    title: "Lemon curd",
    yieldAmount: 2,
    yieldUnit: "cup",
    items: [
      {
        kind: "ingredient",
        quantity: 2,
        unit: "cup",
        displayName: "Sugar",
        preparationNote: "sifted",
        subrecipeId: null,
      },
      {
        kind: "ingredient",
        quantity: 4,
        unit: "each",
        displayName: "Eggs",
        preparationNote: "",
        subrecipeId: null,
      },
    ],
    ...partial,
  }
}

function subrecipeRow(partial: Partial<RecipeItemState> = {}): RecipeItemState {
  return item({
    kind: "subrecipe",
    displayName: "Lemon curd",
    // A whole batch of the child by default, so a test that cares about the
    // batch factor is the one that sets the quantity.
    quantity: "2",
    unit: "cup",
    subrecipeId: "recipe-9",
    subrecipe: curd(),
    ...partial,
  })
}

/** The nested lines as one string each: "1 cup Sugar sifted". */
function nestedLines() {
  return screen.getAllByRole("listitem").map((one) =>
    Array.from(one.children)
      .map((part) => part.textContent)
      .join(" ")
  )
}

describe("recipe items table sub-recipes", () => {
  it("opens the sub-recipe in a new tab from the panel", () => {
    render(<Harness initial={[subrecipeRow()]} />)
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    const link = screen.getByRole("link", {
      name: "Open sub-recipe for prep method",
    })
    expect(link.getAttribute("href")).toBe("/recipes/rcp_lemoncurd/recipe")
    expect(link.getAttribute("target")).toBe("_blank")
  })

  it("shows the nested lines only once the chevron is clicked", () => {
    render(<Harness initial={[subrecipeRow()]} />)
    expect(screen.queryByText("Sub-recipe")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(screen.getByText("Sub-recipe")).toBeTruthy()
    expect(nestedLines()).toEqual(["2 cup Sugar sifted", "4 ea Eggs"])
    fireEvent.click(screen.getByRole("button", { name: "Hide sub-recipe" }))
    expect(screen.queryByText("Sub-recipe")).toBeNull()
  })

  it("keeps a nested recipe's headers and notes distinct", () => {
    render(
      <Harness
        initial={[
          subrecipeRow({
            subrecipe: curd({
              items: [
                {
                  kind: "header",
                  quantity: null,
                  unit: "",
                  displayName: "To finish",
                  preparationNote: "",
                  subrecipeId: null,
                },
                {
                  kind: "note",
                  quantity: null,
                  unit: "",
                  displayName: "Keep chilled",
                  preparationNote: "",
                  subrecipeId: null,
                },
              ],
            }),
          }),
        ]}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(
      screen.getByRole("heading", { level: 4, name: "To finish" })
    ).toBeTruthy()
    expect(screen.getByText("Keep chilled").className).toContain("italic")
  })

  it("reads one each of a one each recipe as a whole batch", () => {
    render(
      <Harness
        initial={[
          subrecipeRow({
            displayName: "Tart crust",
            quantity: "1",
            unit: "each",
            subrecipe: curd({
              title: "Tart crust",
              yieldAmount: 1,
              yieldUnit: "each",
              items: [
                {
                  kind: "ingredient",
                  quantity: 200,
                  unit: "g",
                  displayName: "Flour",
                  preparationNote: "",
                  subrecipeId: null,
                },
              ],
            }),
          }),
        ]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(screen.getByText("1x")).toBeTruthy()
    expect(screen.getByText("1 ea")).toBeTruthy()
    expect(nestedLines()).toEqual(["200 g Flour"])
    expect(screen.queryByText("Shown at 1x")).toBeNull()
  })

  it("reads the recipe's whole yield as a whole batch, fraction and all", () => {
    render(
      <Harness
        initial={[
          subrecipeRow({
            quantity: "2.75",
            unit: "cup",
            subrecipe: curd({ yieldAmount: 2.75, yieldUnit: "cup" }),
          }),
        ]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(screen.getByText("1x")).toBeTruthy()
    expect(screen.getByText("2 3/4 cup")).toBeTruthy()
    expect(nestedLines()).toEqual(["2 cup Sugar sifted", "4 ea Eggs"])
  })

  it("halves the lines when the row asks for half a batch", () => {
    render(<Harness initial={[subrecipeRow({ quantity: "1", unit: "cup" })]} />)
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(screen.getByText("0.5x")).toBeTruthy()
    expect(screen.getByText("1 cup")).toBeTruthy()
    expect(nestedLines()).toEqual(["1 cup Sugar sifted", "2 ea Eggs"])
  })

  it("says so and shows the recipe as written when the units do not relate", () => {
    render(
      <Harness initial={[subrecipeRow({ quantity: "3", unit: "each" })]} />
    )
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(screen.getByText("1x")).toBeTruthy()
    expect(screen.getByText("Shown at 1x")).toBeTruthy()
    expect(screen.getByText("2 cup")).toBeTruthy()
    expect(nestedLines()).toEqual(["2 cup Sugar sifted", "4 ea Eggs"])
  })

  it("does not flash a link or toggle while the link is unsaved", () => {
    render(<Harness initial={[subrecipeRow({ subrecipe: null })]} />)
    expect(screen.queryByRole("button", { name: "Show sub-recipe" })).toBeNull()
    expect(
      screen.queryByRole("link", { name: "Open sub-recipe for prep method" })
    ).toBeNull()
  })

  it("waits for saved lines before showing a sub-recipe control", async () => {
    render(
      <Harness
        initial={[]}
        recipes={[
          { id: "rec-curd", publicId: "rcp_curd", title: "Lemon Curd" },
        ]}
      />
    )
    await quickAddLine("2 3/4 cups Lemon Curd")
    expect(screen.getByTestId("links").textContent).toContain(
      "subrecipe:rec-curd"
    )
    expect(screen.queryByRole("button", { name: "Show sub-recipe" })).toBeNull()
    expect(
      screen.queryByRole("link", { name: "Open sub-recipe for prep method" })
    ).toBeNull()
  })

  it("names the sub-recipe in plain text when the recipe is read-only", () => {
    render(<Harness initial={[subrecipeRow()]} canEdit={false} />)
    expect(screen.queryByLabelText("Ingredient or recipe")).toBeNull()
    expect(screen.getByText("Lemon curd")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(nestedLines()).toEqual(["2 cup Sugar sifted", "4 ea Eggs"])
  })
})

describe("recipe items table quick add linking", () => {
  it("links a size word to the pantry preparation it names", async () => {
    render(
      <Harness
        initial={[]}
        targets={[
          { id: "pantry-egg", name: "Egg", preparations: ["large", "medium"] },
        ]}
      />
    )
    await quickAddLine("3 large eggs")
    expect(screen.getByTestId("rows").textContent).toBe("Egg/large/pantry-egg")
    expect(screen.getByTestId("order").textContent).toBe("ingredient:3")
    expect(searchMock).not.toHaveBeenCalled()
  })

  it("pulls an exact catalog match into the pantry and links it", async () => {
    searchMock.mockResolvedValue({
      items: [
        {
          id: "cat-lemon",
          name: "Lemon juice",
          preparations: [],
          aliases: [],
        },
      ],
    })
    activateMock.mockResolvedValue({
      id: "pantry-lemon",
      name: "Lemon juice",
      created: true,
      preparations: [],
    })
    render(<Harness initial={[]} />)
    await quickAddLine("1 cup lemon juice")
    expect(activateMock).toHaveBeenCalledWith("cat-lemon")
    expect(screen.getByTestId("rows").textContent).toBe(
      "Lemon juice//pantry-lemon"
    )
    expect(screen.getByTestId("targets").textContent).toBe("Lemon juice")
  })

  it("links a line that names one of the cook's own recipes", async () => {
    render(
      <Harness
        initial={[]}
        recipes={[{ id: "rec-curd", title: "Lemon Curd" }]}
      />
    )
    await quickAddLine("2 3/4 cups Lemon Curd")
    expect(screen.getByTestId("links").textContent).toBe("subrecipe:rec-curd")
    expect(screen.getByTestId("rows").textContent).toBe("Lemon Curd//null")
    expect(searchMock).not.toHaveBeenCalled()
  })

  it("adds a row for every line of a pasted list", async () => {
    searchMock.mockResolvedValue({ items: [] })
    render(
      <Harness
        initial={[]}
        targets={[
          { id: "pantry-egg", name: "Egg", preparations: ["large"] },
          { id: "pantry-sugar", name: "Sugar" },
        ]}
        recipes={[{ id: "rec-curd", title: "Lemon Curd" }]}
      />
    )
    const pasted = [
      "# Filling",
      "3 large eggs",
      "1 cup sugar",
      "2 tbsp butter, softened",
      "> chill overnight",
      "1 tsp vanilla",
      "2 3/4 cups Lemon Curd",
    ].join("\n")
    fireEvent.paste(screen.getByLabelText("Quick add ingredient"), {
      clipboardData: { getData: () => pasted },
    })
    await waitFor(() =>
      expect(screen.getByTestId("order").textContent.split("|")).toHaveLength(7)
    )
    expect(screen.getByTestId("rows").textContent).toContain(
      "Egg/large/pantry-egg"
    )
    expect(screen.getByTestId("rows").textContent).toContain(
      "Sugar//pantry-sugar"
    )
    expect(screen.getByTestId("links").textContent).toContain(
      "subrecipe:rec-curd"
    )
  })
})

describe("recipe items table notes on a pick", () => {
  it("keeps the note the line already carried", async () => {
    searchMock.mockResolvedValue({
      items: [
        { id: "cat-butter", name: "Butter", preparations: [], aliases: [] },
      ],
    })
    activateMock.mockResolvedValue({
      id: "pantry-butter",
      name: "Butter",
      created: true,
      preparations: [],
    })
    render(
      <Harness
        initial={[item({ displayName: "", preparationNote: "softened" })]}
      />
    )
    openPicker("butt")
    await screen.findAllByText("Catalog")
    fireEvent.click(screen.getAllByRole("option")[0])
    await screen.findByText("Butter/softened/pantry-butter")
  })

  it("puts a picked preparation in front of the note", async () => {
    render(
      <Harness
        initial={[item({ displayName: "", preparationNote: "2 ounces" })]}
        targets={[{ id: "pantry-9", name: "Carrot", preparations: ["diced"] }]}
      />
    )
    openPicker("carr")
    await screen.findAllByText("Catalog")
    fireEvent.click(screen.getByRole("option", { name: "Carrot, diced" }))
    await screen.findByText("Carrot/diced, 2 ounces/pantry-9")
  })
})

describe("recipe items table sub-recipes counted in pieces", () => {
  it("reads one each of a one piece recipe as a whole batch", () => {
    render(
      <Harness
        initial={[
          subrecipeRow({
            displayName: "Tart crust",
            quantity: "1",
            unit: "each",
            subrecipe: curd({
              title: "Tart crust",
              yieldAmount: 1,
              yieldUnit: "pcs",
              items: [
                {
                  kind: "ingredient",
                  quantity: 200,
                  unit: "g",
                  displayName: "Flour",
                  preparationNote: "",
                  subrecipeId: null,
                },
              ],
            }),
          }),
        ]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(screen.getByText("1x")).toBeTruthy()
    expect(screen.queryByText("Shown at 1x")).toBeNull()
  })

  it("reads one slice of an eight slice recipe as an eighth of a batch", () => {
    render(
      <Harness
        initial={[
          subrecipeRow({
            displayName: "Lemon tart",
            quantity: "1",
            unit: "slice",
            subrecipe: curd({
              title: "Lemon tart",
              yieldAmount: 8,
              yieldUnit: "slice",
              items: [
                {
                  kind: "ingredient",
                  quantity: 800,
                  unit: "g",
                  displayName: "Flour",
                  preparationNote: "",
                  subrecipeId: null,
                },
              ],
            }),
          }),
        ]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(screen.getByText("0.13x")).toBeTruthy()
  })

  it("relates a piece line to a sliced yield, and back the other way", () => {
    const { unmount } = render(
      <Harness
        initial={[
          subrecipeRow({
            displayName: "Lemon tart",
            quantity: "2",
            unit: "pcs",
            subrecipe: curd({
              title: "Lemon tart",
              yieldAmount: 8,
              yieldUnit: "slice",
              items: [],
            }),
          }),
        ]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(screen.getByText("0.25x")).toBeTruthy()
    unmount()

    render(
      <Harness
        initial={[
          subrecipeRow({
            displayName: "Tart crust",
            quantity: "1",
            unit: "slice",
            subrecipe: curd({
              title: "Tart crust",
              yieldAmount: 1,
              yieldUnit: "pcs",
              items: [],
            }),
          }),
        ]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Show sub-recipe" }))
    expect(screen.getByText("1x")).toBeTruthy()
  })
})
