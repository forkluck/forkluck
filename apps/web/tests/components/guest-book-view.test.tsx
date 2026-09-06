// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { GuestBookView } from "@/components/recipes/guest-book-view"
import type { GuestBook, GuestRecipe } from "@/lib/backend/types"
import { MARKETING_ORIGIN } from "@/lib/public-site"

const recipe = (
  title: string,
  ingredient: string,
  quantity: number
): GuestRecipe => ({
  role: "viewer",
  title,
  description: "",
  yieldAmount: 4,
  yieldUnit: "cup",
  servingAmount: null,
  servingUnit: "",
  batchSizes: [{ label: "1x", scale: 1, isOriginal: true }],
  items: [
    {
      kind: "ingredient",
      displayName: ingredient,
      quantity,
      unit: "cup",
      preparationNote: "",
      subrecipe: null,
    },
  ],
  steps: [],
  ownerName: "Renée",
})

const BOOK: GuestBook = {
  title: "Bar program",
  ownerName: "Renée",
  role: "viewer",
  recipes: [recipe("Mooncake", "Flour", 2), recipe("Shortbread", "Sugar", 3)],
}

/** The `<details>` one recipe's line and sheet live in. */
function entry(title: string): HTMLDetailsElement {
  const heading = screen.getByRole("heading", { level: 2, name: title })
  const details = heading.closest("details")
  if (!details) throw new Error(`no entry for ${title}`)
  return details
}

async function scale(title: string, label: string) {
  fireEvent.click(within(entry(title)).getByLabelText("Batch size"))
  fireEvent.click(await screen.findByText(label))
}

afterEach(cleanup)

describe("a shared recipe book", () => {
  it("names the book and lists every recipe closed", () => {
    render(<GuestBookView book={BOOK} />)

    expect(
      screen.getByRole("heading", { level: 1, name: "Bar program" })
    ).toBeTruthy()
    expect(screen.getByText("Shared by Renée")).toBeTruthy()
    for (const title of ["Mooncake", "Shortbread"]) {
      const details = entry(title)
      expect(details.open).toBe(false)
      // The line carries the yield at 1x, so it holds still as a sheet scales.
      expect(within(details).getAllByText("Makes 4 cup").length).toBe(2)
    }
  })

  it("opens the only recipe of a one-recipe book", () => {
    render(<GuestBookView book={{ ...BOOK, recipes: [BOOK.recipes[0]] }} />)

    expect(entry("Mooncake").open).toBe(true)
  })

  it("opens one entry without opening its neighbour", () => {
    render(<GuestBookView book={BOOK} />)

    fireEvent.click(screen.getByRole("heading", { level: 2, name: "Mooncake" }))

    expect(entry("Mooncake").open).toBe(true)
    expect(entry("Shortbread").open).toBe(false)
  })

  it("gives every open sheet its own batch", async () => {
    render(<GuestBookView book={BOOK} />)

    fireEvent.click(screen.getByRole("button", { name: "Open all" }))
    await scale("Mooncake", "2x")

    expect(within(entry("Mooncake")).getByText("4")).toBeTruthy()
    expect(within(entry("Mooncake")).getByText("Makes 8 cup")).toBeTruthy()
    expect(within(entry("Shortbread")).getByText("3")).toBeTruthy()
    // Its neighbour, and both summary lines, stay where they were.
    expect(within(entry("Shortbread")).getAllByText("Makes 4 cup").length).toBe(
      2
    )
  })

  it("flips Open all to Close all, and closes every entry again", () => {
    render(<GuestBookView book={BOOK} />)

    fireEvent.click(screen.getByRole("button", { name: "Open all" }))
    expect(entry("Mooncake").open).toBe(true)
    expect(entry("Shortbread").open).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: "Close all" }))
    expect(entry("Mooncake").open).toBe(false)
    expect(entry("Shortbread").open).toBe(false)
  })

  it("invites an editor once, for the whole book", () => {
    const { unmount } = render(
      <GuestBookView book={{ ...BOOK, role: "editor" }} />
    )

    expect(screen.getAllByText(/invited to edit these recipes/).length).toBe(1)
    unmount()
    render(<GuestBookView book={BOOK} />)
    expect(screen.queryByText(/invited to edit/)).toBeNull()
  })

  it("links to the marketing site and the two auth routes, nothing else", () => {
    render(<GuestBookView book={BOOK} />)

    expect(
      [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    ).toEqual([MARKETING_ORIGIN, "/login", "/signup"])
  })
})
