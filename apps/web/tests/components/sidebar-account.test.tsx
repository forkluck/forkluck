// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const signOut = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const showError = vi.hoisted(() => vi.fn())

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: showError }),
}))

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: (...args: unknown[]) => signOut(...args) },
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}))

import { NavigationBlockerProvider } from "@/components/navigation-blocker"
import { SidebarAccount } from "@/components/sidebar-account"
import type { SessionUser } from "@/lib/auth-session"
import { draftKey, writeDraft } from "@/lib/draft-store"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
})

const user = {
  id: "user-1",
  name: "Ada Chef",
  email: "ada@example.test",
} as SessionUser

describe("signing out", () => {
  it("takes this user's drafts with it", async () => {
    signOut.mockResolvedValue({})
    const mine = draftKey({
      workspaceId: "ws-1",
      userId: "user-1",
      kind: "recipe",
      id: "rec-1",
    })
    const theirs = draftKey({
      workspaceId: "ws-1",
      userId: "user-2",
      kind: "recipe",
      id: "rec-2",
    })
    writeDraft(mine, { title: "Focaccia" })
    writeDraft(theirs, { title: "Levain" })

    render(
      <NavigationBlockerProvider>
        <SidebarAccount user={user} />
      </NavigationBlockerProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: /Ada/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }))

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    expect(window.localStorage.getItem(mine)).toBeNull()
    expect(window.localStorage.getItem(theirs)).not.toBeNull()
  })

  it("keeps drafts and offers a retry when the server refuses sign-out", async () => {
    const mine = draftKey({
      workspaceId: "ws-1",
      userId: user.id,
      kind: "recipe",
      id: "rec-1",
    })
    writeDraft(mine, { title: "Focaccia" })
    signOut.mockResolvedValueOnce({ error: { message: "Request failed" } })
    render(
      <NavigationBlockerProvider>
        <SidebarAccount user={user} />
      </NavigationBlockerProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: /Ada/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }))
    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith({
        title: "Couldn't sign out",
        description: "Request failed",
        type: "error",
      })
    )
    expect(push).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(mine)).not.toBeNull()
  })
})
