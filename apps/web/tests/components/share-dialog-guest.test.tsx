// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const shareRecipe = vi.hoisted(() => vi.fn())
const removeRecipeBook = vi.hoisted(() => vi.fn())
const removeRecipeGuestLink = vi.hoisted(() => vi.fn())
const removeRecipeShare = vi.hoisted(() => vi.fn())
const updateRecipeShare = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/recipes/actions", () => ({
  removeRecipeBook,
  removeRecipeGuestLink,
  removeRecipeShare,
  shareRecipe,
  updateRecipeShare,
}))

const toastAdd = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

import { ShareDialog } from "@/components/recipes/share-dialog"
import type { RecipeDetail } from "@/lib/backend/types"

const guestLinks: RecipeDetail["guestLinks"] = [
  {
    id: "gl-1",
    email: "guest@example.com",
    role: "editor",
    createdAt: new Date(),
  },
]

const bookLinks: RecipeDetail["bookLinks"] = [
  {
    id: "bk-1",
    email: "guest@example.com",
    role: "viewer",
    title: "Bar program",
    recipeCount: 3,
    createdAt: new Date(),
  },
  {
    id: "bk-2",
    email: "cook@example.com",
    role: "editor",
    title: "",
    recipeCount: 2,
    createdAt: new Date(),
  },
]

beforeEach(() => {
  removeRecipeBook.mockResolvedValue({ ok: true })
  removeRecipeGuestLink.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function open(
  links: RecipeDetail["guestLinks"] = [],
  books: RecipeDetail["bookLinks"] = []
) {
  render(
    <ShareDialog
      open
      onOpenChange={vi.fn()}
      recipeId="rec-1"
      ownerName="Alex"
      shares={[]}
      guestLinks={links}
      bookLinks={books}
      canEdit
    />
  )
}

function invite(email = "guest@example.com") {
  fireEvent.change(screen.getByPlaceholderText("teammate@example.com"), {
    target: { value: email },
  })
  fireEvent.click(screen.getByRole("button", { name: "Share" }))
}

describe("the share dialog's guest links", () => {
  it("reports the invite a guest result stands for", async () => {
    shareRecipe.mockResolvedValue({
      guest: { id: "gl-2", email: "guest@example.com" },
    })
    open()

    invite()

    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({
        title: "Invite sent to guest@example.com",
      })
    )
    const field = screen.getByPlaceholderText(
      "teammate@example.com"
    ) as HTMLInputElement
    expect(field.value).toBe("")
  })

  it("shows a share error instead of an invite", async () => {
    shareRecipe.mockResolvedValue({
      error: "A verified registered user is required",
    })
    open()

    invite()

    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "A verified registered user is required"
      )
    )
    // The address stays in the field, ready for another try.
    expect(
      (screen.getByPlaceholderText("teammate@example.com") as HTMLInputElement)
        .value
    ).toBe("guest@example.com")
  })

  it("sends the same address again", async () => {
    shareRecipe.mockResolvedValue({
      guest: { id: "gl-2", email: "guest@example.com" },
    })
    open()

    invite()
    const field = screen.getByPlaceholderText(
      "teammate@example.com"
    ) as HTMLInputElement
    await vi.waitFor(() => expect(field.value).toBe(""))
    // The field clears before the save's refresh settles; the button stays
    // pending until it does, and a click on a pending button is ignored.
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Share" }).getAttribute("aria-busy")
      ).toBeNull()
    )
    invite()

    await vi.waitFor(() => expect(shareRecipe).toHaveBeenCalledTimes(2))
  })

  it("reads a pending link as its role, still waiting", () => {
    open(guestLinks)

    expect(screen.getByText("Editor · Invited")).toBeTruthy()
    expect(screen.queryByText("Guest link")).toBeNull()
  })

  it("names a book by its title, or by how many recipes it holds", () => {
    open([], bookLinks)

    expect(screen.getByText("guest@example.com · Bar program")).toBeTruthy()
    expect(screen.getByText("cook@example.com · 2 recipes")).toBeTruthy()
    expect(screen.queryByText("No collaborators yet.")).toBeNull()
  })

  it("revokes a whole book by its id", async () => {
    open(guestLinks, bookLinks)

    fireEvent.click(
      screen.getByRole("button", {
        name: "Revoke the book sent to guest@example.com",
      })
    )

    await vi.waitFor(() =>
      expect(removeRecipeBook).toHaveBeenCalledWith({ bookId: "bk-1" })
    )
    // The recipe's own link to the same address is a separate button.
    expect(removeRecipeGuestLink).not.toHaveBeenCalled()
  })

  it("revokes a guest link by its id", async () => {
    open(guestLinks)

    fireEvent.click(
      screen.getByRole("button", { name: "Revoke guest@example.com" })
    )

    await vi.waitFor(() =>
      expect(removeRecipeGuestLink).toHaveBeenCalledWith({
        recipeId: "rec-1",
        linkId: "gl-1",
      })
    )
  })
})

describe("Cmd+S inside the share dialog", () => {
  it("sends the invite and never reaches the editor behind it", async () => {
    shareRecipe.mockResolvedValue({
      guest: { id: "gl-2", email: "guest@example.com" },
    })
    const behind = vi.fn()
    window.addEventListener("keydown", behind)
    open()

    fireEvent.change(screen.getByPlaceholderText("teammate@example.com"), {
      target: { value: "guest@example.com" },
    })
    // Focus outside the form: the dialog itself still swallows the key.
    fireEvent.keyDown(screen.getByText("Share recipe"), {
      key: "s",
      metaKey: true,
    })

    await waitFor(() => expect(shareRecipe).toHaveBeenCalled())
    expect(behind).not.toHaveBeenCalled()
    window.removeEventListener("keydown", behind)
  })
})
