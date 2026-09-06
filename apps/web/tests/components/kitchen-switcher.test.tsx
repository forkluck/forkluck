// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const push = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
const leaveKitchen = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}))
vi.mock("@/app/(app)/settings/actions", () => ({
  leaveKitchen: (...args: unknown[]) => leaveKitchen(...args),
}))
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))

import { KitchenSwitcher } from "@/components/kitchen-switcher"
import { KITCHEN_COOKIE, type ActiveKitchen } from "@/lib/kitchen"

const ROSA: ActiveKitchen = {
  id: "mem-1",
  ownerId: "user-rosa",
  ownerName: "Rosa",
  role: "editor",
}
const OMAR: ActiveKitchen = {
  id: "mem-2",
  ownerId: "user-omar",
  ownerName: "Omar",
  role: "viewer",
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.cookie = `${KITCHEN_COOKIE}=; path=/; max-age=0`
})

function kitchenCookie() {
  return document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${KITCHEN_COOKIE}=`))
    ?.slice(KITCHEN_COOKIE.length + 1)
}

async function openSwitcher(active: ActiveKitchen | null) {
  render(<KitchenSwitcher kitchens={[ROSA, OMAR]} active={active} />)
  fireEvent.click(screen.getByRole("button"))
  return screen.findAllByRole("menuitem")
}

describe("the kitchen switcher", () => {
  it("offers the account's own kitchen and every membership, with its role", async () => {
    const rows = await openSwitcher(ROSA)

    expect(rows.map((row) => row.textContent)).toEqual([
      "My kitchen",
      "Rosa’s kitchenEditor",
      "Omar’s kitchenViewer",
      "Leave this kitchen",
    ])
  })

  it("checks the kitchen being looked at", async () => {
    await openSwitcher(OMAR)

    expect(
      screen
        .getByRole("menuitem", { name: /Omar/ })
        .getAttribute("data-checked")
    ).toBe("true")
    expect(
      screen
        .getByRole("menuitem", { name: /Rosa/ })
        .getAttribute("data-checked")
    ).toBeNull()
    expect(
      screen
        .getByRole("menuitem", { name: "My kitchen" })
        .getAttribute("data-checked")
    ).toBeNull()
  })

  it("remembers the pick in a cookie and lands on the recipes list", async () => {
    await openSwitcher(null)
    fireEvent.click(screen.getByRole("menuitem", { name: /Rosa/ }))

    expect(kitchenCookie()).toBe("user-rosa")
    expect(push).toHaveBeenCalledWith("/recipes")
    expect(refresh).toHaveBeenCalled()
  })

  it("forgets the cookie on the way back to the user's own kitchen", async () => {
    await openSwitcher(ROSA)
    fireEvent.click(screen.getByRole("menuitem", { name: "My kitchen" }))

    expect(kitchenCookie()).toBeUndefined()
    expect(push).toHaveBeenCalledWith("/recipes")
  })

  it("offers no way out of a kitchen the account owns", async () => {
    const rows = await openSwitcher(null)

    expect(rows.map((row) => row.textContent)).not.toContain(
      "Leave this kitchen"
    )
  })

  it("leaves by membership id, after clearing the cookie", async () => {
    leaveKitchen.mockResolvedValue({ ok: true })
    await openSwitcher(ROSA)
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Leave this kitchen" })
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "Leave kitchen" })
    )

    await waitFor(() =>
      expect(leaveKitchen).toHaveBeenCalledWith({ membershipId: "mem-1" })
    )
    expect(kitchenCookie()).toBeUndefined()
    await waitFor(() => expect(push).toHaveBeenCalledWith("/recipes"))
  })
})
