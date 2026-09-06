// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const listKitchenMembers = vi.hoisted(() => vi.fn())
const inviteKitchenMember = vi.hoisted(() => vi.fn())
const updateKitchenMember = vi.hoisted(() => vi.fn())
const removeKitchenMember = vi.hoisted(() => vi.fn())
const removeKitchenInvite = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/settings/actions", () => ({
  inviteKitchenMember,
  listKitchenMembers,
  removeKitchenInvite,
  removeKitchenMember,
  updateKitchenMember,
}))

const toastAdd = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

import { MembersDialog } from "@/components/settings/members-dialog"

const MEMBER = {
  id: "9f3d2c1a-0000-4000-8000-000000000001",
  memberId: "9f3d2c1a-0000-4000-8000-000000000002",
  name: "Sam Cook",
  email: "sam@example.com",
  role: "viewer" as const,
}
const INVITE = {
  id: "9f3d2c1a-0000-4000-8000-000000000003",
  email: "new@example.com",
  role: "editor" as const,
}

beforeEach(() => {
  listKitchenMembers.mockResolvedValue({
    members: [MEMBER],
    invites: [INVITE],
  })
  inviteKitchenMember.mockResolvedValue({ ok: true, invited: true })
  updateKitchenMember.mockResolvedValue({ ok: true })
  removeKitchenMember.mockResolvedValue({ ok: true })
  removeKitchenInvite.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function open() {
  render(<MembersDialog open onOpenChange={vi.fn()} />)
}

function field() {
  return screen.getByPlaceholderText("cook@example.com") as HTMLInputElement
}

/** Base UI commits a select on a pointer sequence, not on a bare click. */
async function pick(trigger: HTMLElement, label: string) {
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: label })
  fireEvent.pointerDown(option)
  fireEvent.pointerUp(option)
  fireEvent.click(option)
}

describe("the members dialog", () => {
  it("reads the kitchen's members and pending invites", async () => {
    open()

    expect(await screen.findByText("Sam Cook")).toBeTruthy()
    expect(screen.getByText("sam@example.com")).toBeTruthy()
    expect(screen.getByText("new@example.com")).toBeTruthy()
    expect(screen.queryByText("No members yet.")).toBeNull()
  })

  it("says so when the kitchen is the owner's alone", async () => {
    listKitchenMembers.mockResolvedValue({ members: [], invites: [] })
    open()

    expect(await screen.findByText("No members yet.")).toBeTruthy()
  })

  it("invites an address at the chosen role and empties the field", async () => {
    open()
    await screen.findByText("Sam Cook")

    fireEvent.change(field(), { target: { value: "new@example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Invite" }))

    await vi.waitFor(() =>
      expect(inviteKitchenMember).toHaveBeenCalledWith({
        email: "new@example.com",
        role: "viewer",
      })
    )
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({
        title: "Invite sent to new@example.com",
      })
    )
    await vi.waitFor(() => expect(field().value).toBe(""))
  })

  it("says an account joined rather than was invited", async () => {
    inviteKitchenMember.mockResolvedValue({ ok: true, invited: false })
    open()
    await screen.findByText("Sam Cook")

    fireEvent.change(field(), { target: { value: "sam@example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Invite" }))

    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({
        title: "sam@example.com added",
      })
    )
  })

  it("changes a role by the member's account id", async () => {
    open()
    await screen.findByText("Sam Cook")

    // The first picker is the invite form's; the second belongs to the row.
    await pick(screen.getAllByRole("combobox")[1]!, "Editor")

    await vi.waitFor(() =>
      expect(updateKitchenMember).toHaveBeenCalledWith({
        memberId: MEMBER.memberId,
        role: "editor",
      })
    )
    // The list is dialog-local, so it re-reads instead of refreshing the page.
    await vi.waitFor(() => expect(listKitchenMembers).toHaveBeenCalledTimes(2))
  })

  it("removes a member by the membership row", async () => {
    open()
    await screen.findByText("Sam Cook")

    fireEvent.click(screen.getByRole("button", { name: "Remove Sam Cook" }))

    await vi.waitFor(() =>
      expect(removeKitchenMember).toHaveBeenCalledWith({
        membershipId: MEMBER.id,
      })
    )
  })

  it("reads a pending invite as its role, still waiting, and revokes it", async () => {
    open()

    expect(await screen.findByText("Editor · Invited")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke new@example.com" })
    )

    await vi.waitFor(() =>
      expect(removeKitchenInvite).toHaveBeenCalledWith({ inviteId: INVITE.id })
    )
  })

  it("shows why a row write did not land", async () => {
    removeKitchenMember.mockResolvedValue({ error: "Member not found" })
    open()
    await screen.findByText("Sam Cook")

    fireEvent.click(screen.getByRole("button", { name: "Remove Sam Cook" }))

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Member not found"
    )
  })
})
