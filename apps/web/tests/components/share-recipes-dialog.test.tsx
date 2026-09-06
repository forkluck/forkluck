// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const shareRecipes = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/recipes/actions", () => ({ shareRecipes }))

const toastAdd = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

const refresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}))

import { ShareRecipesDialog } from "@/components/recipes/share-recipes-dialog"

const onOpenChange = vi.fn()
const onShared = vi.fn()

function open(titles: string[]) {
  render(
    <ShareRecipesDialog
      open
      onOpenChange={onOpenChange}
      recipes={titles.map((title, index) => ({ id: `rec-${index}`, title }))}
      onShared={onShared}
    />
  )
}

function send(email = "chef@example.com") {
  fireEvent.change(screen.getByPlaceholderText("teammate@example.com"), {
    target: { value: email },
  })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("sharing a selection of recipes", () => {
  it("names one recipe without asking for a book title", () => {
    open(["Mooncake"])

    expect(screen.getByText("Share recipe")).toBeTruthy()
    expect(screen.getByText("Mooncake")).toBeTruthy()
    expect(screen.queryByLabelText("Book title")).toBeNull()
  })

  it("counts several, names the first two, and offers a book title", () => {
    open(["Mooncake", "Shortbread", "Canelé", "Kouign-amann"])

    expect(screen.getByText("Share 4 recipes")).toBeTruthy()
    expect(screen.getByText("Mooncake, Shortbread and 2 more")).toBeTruthy()
    expect(screen.getByLabelText("Book title")).toBeTruthy()
  })

  it("sends the whole selection, with the book title when one is typed", async () => {
    shareRecipes.mockResolvedValue({ shared: 0, guest: null })
    open(["Mooncake", "Shortbread"])

    fireEvent.change(screen.getByLabelText("Book title"), {
      target: { value: "  Bar program  " },
    })
    send()

    await vi.waitFor(() =>
      expect(shareRecipes).toHaveBeenCalledWith({
        recipeIds: ["rec-0", "rec-1"],
        email: "chef@example.com",
        role: "viewer",
        title: "Bar program",
      })
    )
    expect(toastAdd).toHaveBeenCalledWith({
      title: "chef@example.com added to Bar program",
    })
  })

  it("leaves the title out when the field is empty", async () => {
    shareRecipes.mockResolvedValue({ shared: 2, guest: null })
    open(["Mooncake", "Shortbread"])

    send()

    await vi.waitFor(() =>
      expect(shareRecipes).toHaveBeenCalledWith({
        recipeIds: ["rec-0", "rec-1"],
        email: "chef@example.com",
        role: "viewer",
      })
    )
    expect(toastAdd).toHaveBeenCalledWith({
      title: "chef@example.com added to 2 recipes",
    })
    expect(refresh).toHaveBeenCalled()
    expect(onShared).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("names the one recipe an account holder was added to", async () => {
    shareRecipes.mockResolvedValue({ shared: 1, guest: null })
    open(["Mooncake"])

    send()

    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({
        title: "chef@example.com added to Mooncake",
      })
    )
  })

  it("reports an address with no account as an invitation", async () => {
    shareRecipes.mockResolvedValue({
      shared: 0,
      guest: {
        id: "bk-1",
        email: "guest@example.com",
        role: "viewer",
        title: "",
      },
    })
    open(["Mooncake", "Shortbread"])

    send("guest@example.com")

    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({
        title: "Invite sent to guest@example.com",
      })
    )
  })

  it("shows a refusal instead of a toast, and stays open", async () => {
    shareRecipes.mockResolvedValue({ error: "Recipe not found" })
    open(["Mooncake", "Shortbread"])

    send()

    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Recipe not found")
    )
    expect(toastAdd).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("asks before dropping an address that was never sent", () => {
    open(["Mooncake", "Shortbread"])

    fireEvent.change(screen.getByPlaceholderText("teammate@example.com"), {
      target: { value: "chef@example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    expect(screen.getByText("Discard changes?")).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("closes an untouched dialog without asking", () => {
    open(["Mooncake", "Shortbread"])

    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
