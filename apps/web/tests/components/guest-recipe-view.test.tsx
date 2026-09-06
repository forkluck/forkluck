// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { GuestRecipeView } from "@/components/recipes/guest-recipe-view"
import type { GuestRecipe } from "@/lib/backend/types"
import { MARKETING_ORIGIN } from "@/lib/public-site"

const RECIPE: GuestRecipe = {
  role: "viewer",
  title: "Pastry Cream",
  description: "The house custard.",
  yieldAmount: 4,
  yieldUnit: "cup",
  servingAmount: null,
  servingUnit: "",
  batchSizes: [
    { label: "1x", scale: 1, isOriginal: true },
    { label: "4x", scale: 4, isOriginal: false },
  ],
  items: [
    {
      kind: "header",
      displayName: "Dough",
      quantity: null,
      unit: "",
      preparationNote: "",
      subrecipe: null,
    },
    {
      kind: "ingredient",
      displayName: "Flour",
      quantity: 2,
      unit: "cup",
      preparationNote: "sifted",
      subrecipe: null,
    },
    {
      kind: "note",
      displayName: "Rest overnight",
      quantity: null,
      unit: "",
      preparationNote: "",
      subrecipe: null,
    },
    {
      kind: "subrecipe",
      displayName: "Praline paste",
      quantity: 1,
      unit: "cup",
      preparationNote: "",
      subrecipe: {
        title: "Praline paste",
        yieldAmount: 2,
        yieldUnit: "cup",
        items: [
          {
            kind: "header",
            displayName: "To finish",
            quantity: null,
            unit: "",
            preparationNote: "",
          },
          {
            kind: "ingredient",
            displayName: "Hazelnuts",
            quantity: 201.334,
            unit: "g",
            preparationNote: "toasted",
          },
        ],
      },
    },
    // A weight of a recipe that yields a volume: the two cannot be related.
    {
      kind: "subrecipe",
      displayName: "Spice blend",
      quantity: 3,
      unit: "g",
      preparationNote: "",
      subrecipe: {
        title: "Spice blend",
        yieldAmount: 3,
        yieldUnit: "cup",
        items: [
          {
            kind: "ingredient",
            displayName: "Cinnamon",
            quantity: 10,
            unit: "g",
            preparationNote: "",
          },
        ],
      },
    },
  ],
  steps: [
    { kind: "header", title: "Mix", body: "" },
    { kind: "instruction", title: "", body: "Whisk the yolks." },
    { kind: "note", title: "", body: "Do not boil." },
  ],
  ownerName: "Renée",
}

/** The row a named line sits on, so its cells can be read together. A
 * component's name is also a block heading, which sits outside any table. */
function row(name: string): HTMLTableRowElement {
  const tr = screen
    .getAllByText(name)
    .map((node) => node.closest("tr"))
    .find((node): node is HTMLTableRowElement => node !== null)
  if (!tr) throw new Error(`no row for ${name}`)
  return tr
}

/** A component's block: its heading line and its own table. */
function block(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { level: 3, name: title })
  const wrapper = heading.parentElement?.parentElement
  if (!wrapper) throw new Error(`no block for ${title}`)
  return wrapper
}

/** What a row's cells read, in column order. */
function cells(tr: HTMLTableRowElement): string[] {
  return [...tr.querySelectorAll("td")].map(
    (td) => td.textContent?.trim() ?? ""
  )
}

async function chooseBatch(label: string) {
  fireEvent.click(screen.getByLabelText("Batch size"))
  fireEvent.click(await screen.findByText(label))
}

afterEach(cleanup)

describe("guest recipe view", () => {
  it("reads at 1x", () => {
    render(<GuestRecipeView recipe={RECIPE} />)
    expect(
      screen.getByRole("heading", { level: 1, name: "Pastry Cream" })
    ).toBeTruthy()
    expect(screen.getByText("Shared by Renée")).toBeTruthy()
    expect(within(row("Flour")).getByText("2")).toBeTruthy()
    expect(screen.getByText("Makes 4 cup")).toBeTruthy()
    expect(screen.getByText("Shared with you on Forkluck")).toBeTruthy()
  })

  it("doubles the lines and the yield at 2x", async () => {
    render(<GuestRecipeView recipe={RECIPE} />)
    await chooseBatch("2x")
    expect(within(row("Flour")).getByText("4")).toBeTruthy()
    expect(screen.getByText("Makes 8 cup")).toBeTruthy()
  })

  it("scales to a batch typed into the calculator", async () => {
    render(<GuestRecipeView recipe={RECIPE} />)
    fireEvent.click(screen.getByLabelText("Batch size"))
    fireEvent.click(await screen.findByText("Custom…"))
    fireEvent.change(await screen.findByLabelText(/Multiply by/), {
      target: { value: "3" },
    })
    fireEvent.click(screen.getByRole("button", { name: "View at 3x" }))
    expect(within(row("Flour")).getByText("6")).toBeTruthy()
    expect(screen.getByText("Makes 12 cup")).toBeTruthy()
  })

  it("scales a sub-recipe by what the parent line asks of its yield", async () => {
    render(<GuestRecipeView recipe={RECIPE} />)
    // 1 cup of a 2 cup yield is half a batch: the reader sees what that makes,
    // never the multiplier, and the block's weight rounds to what a scale shows.
    expect(within(block("Praline paste")).getByText("Makes 1 cup")).toBeTruthy()
    expect(cells(row("Hazelnuts"))).toEqual([
      "100.7",
      "g",
      "Hazelnuts toasted",
      "toasted",
    ])
    await chooseBatch("2x")
    // The parent line doubles to 2 cup, which is one whole child batch.
    expect(within(block("Praline paste")).getByText("Makes 2 cup")).toBeTruthy()
    expect(cells(row("Hazelnuts"))[0]).toBe("201.3")
    expect(screen.queryByText(/Batch size \d/)).toBeNull()
  })

  it("gives a component its own table, in the same columns", () => {
    render(<GuestRecipeView recipe={RECIPE} />)
    const hazelnuts = row("Hazelnuts")
    // Same column count as the recipe's own lines, so "100.7" sits under "2".
    expect(hazelnuts.querySelectorAll("td").length).toBe(
      row("Flour").querySelectorAll("td").length
    )
    expect(hazelnuts.closest("table")).not.toBe(row("Flour").closest("table"))
    // The list names the component once, in the weight its block heading has.
    expect(cells(row("Praline paste"))).toEqual([
      "1",
      "cup",
      "Praline paste",
      "",
    ])
  })

  it("tags every component block as a sub-recipe", () => {
    render(<GuestRecipeView recipe={RECIPE} />)
    expect(screen.getAllByText("Sub-recipe").length).toBe(2)
    expect(within(block("Praline paste")).getByText("Sub-recipe")).toBeTruthy()
  })

  it("keeps a component's header as a row across its table", () => {
    render(<GuestRecipeView recipe={RECIPE} />)
    const rows = [
      ...block("Praline paste").querySelectorAll<HTMLTableRowElement>(
        "tbody tr"
      ),
    ]
    expect(rows.map((tr) => cells(tr)[0])).toEqual(["To finish", "100.7"])
    expect(rows[0].querySelector("td")?.colSpan).toBe(4)
  })

  it("falls back to 1x when the line cannot be related to the yield", () => {
    render(<GuestRecipeView recipe={RECIPE} />)
    expect(
      within(block("Spice blend")).getByText("Shown at 1x · Makes 3 cup")
    ).toBeTruthy()
    expect(cells(row("Cinnamon"))[0]).toBe("10")
  })

  it("reads weights the way a scale shows them, and volumes as fractions", () => {
    const recipe: GuestRecipe = {
      ...RECIPE,
      yieldAmount: 12,
      yieldUnit: "pcs",
      items: [
        {
          kind: "ingredient",
          displayName: "Cake flour",
          quantity: 8.6667,
          unit: "g",
          preparationNote: "",
          subrecipe: null,
        },
        {
          kind: "ingredient",
          displayName: "Salt",
          quantity: 0.022,
          unit: "g",
          preparationNote: "",
          subrecipe: null,
        },
        {
          kind: "ingredient",
          displayName: "Butter",
          quantity: 1.2345,
          unit: "oz",
          preparationNote: "",
          subrecipe: null,
        },
        {
          kind: "ingredient",
          displayName: "Milk",
          quantity: 1 / 3,
          unit: "cup",
          preparationNote: "",
          subrecipe: null,
        },
      ],
    }
    render(<GuestRecipeView recipe={recipe} />)
    expect(cells(row("Cake flour"))[0]).toBe("8.7")
    expect(cells(row("Salt"))[0]).toBe("0.022")
    expect(cells(row("Butter"))[0]).toBe("1.23")
    expect(cells(row("Milk"))[0]).toBe("1/3")
    // "pcs" is the stored unit; a cook reads "ea".
    expect(screen.getByText("Makes 12 ea")).toBeTruthy()
  })

  it("draws the notes column only when some line has a note", () => {
    const { unmount } = render(<GuestRecipeView recipe={RECIPE} />)
    // One per table: the recipe's own list, plus a block for each component.
    expect(screen.getAllByRole("columnheader", { name: "Notes" }).length).toBe(
      3
    )
    unmount()
    const quiet: GuestRecipe = {
      ...RECIPE,
      items: RECIPE.items.map((item) => ({
        ...item,
        preparationNote: "",
        subrecipe: item.subrecipe
          ? {
              ...item.subrecipe,
              items: item.subrecipe.items.map((line) => ({
                ...line,
                preparationNote: "",
              })),
            }
          : null,
      })),
    }
    render(<GuestRecipeView recipe={quiet} />)
    expect(screen.queryAllByRole("columnheader", { name: "Notes" })).toEqual([])
    expect(cells(row("Flour"))).toEqual(["2", "cup", "Flour"])
  })

  it("invites an editor to claim the recipe, and tells a viewer nothing", () => {
    const { unmount } = render(
      <GuestRecipeView recipe={{ ...RECIPE, role: "editor" }} />
    )
    expect(
      screen.getByText(/You're invited to edit this recipe\./)
    ).toBeTruthy()
    unmount()
    render(<GuestRecipeView recipe={RECIPE} />)
    expect(screen.queryByText(/invited to edit/)).toBeNull()
  })

  it("says nothing about money", () => {
    render(<GuestRecipeView recipe={RECIPE} />)
    const text = document.body.textContent ?? ""
    for (const word of ["$", "Cost", "Price", "Nutrition"]) {
      expect(text).not.toContain(word)
    }
  })

  it("links to the marketing site and the two auth routes, nothing else", () => {
    render(<GuestRecipeView recipe={RECIPE} />)
    const links = [...document.querySelectorAll("a")]
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      MARKETING_ORIGIN,
      "/login",
      "/signup",
    ])
    // The two are Buttons rendered as anchors, so they read as buttons.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Get started" })).toBeTruthy()
  })
})
