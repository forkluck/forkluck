// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { ShareButton, sharedWith } from "@/components/recipes/share-button"
import { TooltipProvider } from "@/components/ui/tooltip"

const onClick = vi.fn()

type Props = Parameters<typeof ShareButton>[0]

function share(id: string, recipientName: string): Props["shares"][number] {
  return { id, recipientId: `user-${id}`, recipientName, role: "viewer" }
}

function guest(id: string, email: string): Props["guestLinks"][number] {
  return { id, email, role: "viewer", createdAt: new Date(0) }
}

function book(
  id: string,
  email: string
): NonNullable<Props["bookLinks"]>[number] {
  return {
    id,
    email,
    role: "viewer",
    title: "",
    recipeCount: 2,
    createdAt: new Date(0),
  }
}

function open(props: Partial<Props> = {}) {
  render(
    <TooltipProvider>
      <ShareButton
        shares={[]}
        guestLinks={[]}
        bookLinks={[]}
        onClick={onClick}
        {...props}
      />
    </TooltipProvider>
  )
}

const tooltip = () => document.querySelector("[data-slot=tooltip-content]")

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the header's Share button", () => {
  it("is a plain Share with nobody to count", () => {
    open()
    const button = screen.getByRole("button", { name: "Share" })
    expect(button.querySelector("[data-slot=badge]")).toBeNull()
    fireEvent.mouseEnter(button)
    fireEvent.mouseMove(button)
    expect(tooltip()).toBeNull()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("counts the people and names them on hover", async () => {
    open({
      shares: [share("s1", "Queenie Fok"), share("s2", "Jo Doe")],
      guestLinks: [guest("g1", "ana@example.com")],
    })
    const button = screen.getByRole("button", { name: /^Share/ })
    expect(button.querySelector("[data-slot=badge]")?.textContent).toBe("3")

    fireEvent.mouseEnter(button)
    fireEvent.mouseMove(button)
    await waitFor(() =>
      expect(tooltip()?.textContent).toBe(
        "Shared with Queenie Fok, Jo Doe and 1 more"
      )
    )
  })

  it("counts an address once when it holds a guest link and a book", () => {
    open({
      guestLinks: [guest("g1", "Ana@example.com")],
      bookLinks: [book("b1", "ana@example.com"), book("b2", "bo@example.com")],
    })
    const button = screen.getByRole("button", { name: /^Share/ })
    expect(button.querySelector("[data-slot=badge]")?.textContent).toBe("2")
  })

  it("waits for a saved recipe", () => {
    open({ disabled: true })
    expect(
      (screen.getByRole("button", { name: "Share" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })
})

describe("who a recipe is shared with", () => {
  it("lists accounts first, then the invited addresses in order", () => {
    expect(
      sharedWith({
        shares: [share("s1", "Queenie Fok")],
        guestLinks: [guest("g1", "bo@example.com")],
        bookLinks: [book("b1", "ana@example.com")],
      })
    ).toEqual(["Queenie Fok", "bo@example.com", "ana@example.com"])
  })
})
