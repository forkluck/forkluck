// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const state = vi.hoisted(() => ({
  pathname: "/recipes/rcp_0123456789ab/cost",
  search: "",
}))

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock("@/app/(app)/actions", () => ({
  renamePrimoConversation: vi.fn(),
  archivePrimoConversation: vi.fn(),
  deletePrimoConversation: vi.fn(),
}))
vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    status: "ready",
    error: undefined,
    regenerate: vi.fn(),
    stop: vi.fn(),
    setMessages: vi.fn(),
  }),
}))
vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: ({ onCollapse }: { onCollapse: () => void }) => (
    <button type="button" onClick={onCollapse}>
      Collapse test sidebar
    </button>
  ),
}))
vi.mock("@/components/primo/primo-rail", () => ({
  PrimoRail: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Close test Primo
    </button>
  ),
}))
vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({ go: vi.fn(), pending: false }),
  NavigationBlockerProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  useNavigationBlocker: () => ({
    allowNavigation: vi.fn(),
    confirmNavigation: vi.fn().mockResolvedValue(true),
  }),
}))
vi.mock("@/components/ui/toast", () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/components/primo/kitchen-tools-webmcp", () => ({
  KitchenToolsWebMcp: () => null,
}))

import { AppShell } from "@/components/app-shell"
import { usePrimo } from "@/components/primo/primo-provider"
import type { SessionUser } from "@/lib/auth-session"

function InlinePrimo() {
  const { registerInline } = usePrimo()
  React.useEffect(() => registerInline(), [registerInline])
  return <main>Chat</main>
}

afterEach(cleanup)

beforeEach(() => {
  state.pathname = "/recipes/rcp_0123456789ab/cost"
  state.search = ""
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  )
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
})

describe("read-only banner", () => {
  it("sits above the page only while the account is read-only", () => {
    const { rerender } = render(
      <AppShell
        user={{ id: "1", name: "Ada", email: "ada@example.com" } as SessionUser}
        readOnlyNotice="Your trial ended. Subscribe to keep editing."
      >
        <main>Recipe</main>
      </AppShell>
    )
    expect(
      screen.getByText("Your trial ended. Subscribe to keep editing.")
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Subscribe" }).getAttribute("href")
    ).toBe("/subscribe")
    rerender(
      <AppShell
        user={{ id: "1", name: "Ada", email: "ada@example.com" } as SessionUser}
      >
        <main>Recipe</main>
      </AppShell>
    )
    expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull()
  })
})

describe("Primo shell integration", () => {
  it("implements the four desktop grid states and restores trigger focus", () => {
    const { container } = render(
      <AppShell
        user={{ id: "1", name: "Ada", email: "ada@example.com" } as SessionUser}
        primoEnabled
      >
        <main>Recipe</main>
      </AppShell>
    )
    const grid = container.querySelector("[data-app-shell] > div")
    expect(grid?.className).toContain("lg:grid-cols-[248px_1fr]")

    const trigger = screen.getByRole("button", { name: "Open Primo" })
    fireEvent.click(trigger)
    expect(grid?.className).toContain("lg:grid-cols-[248px_1fr_360px]")

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse test sidebar" })
    )
    expect(grid?.className).toContain("lg:grid-cols-[1fr_360px]")

    fireEvent.click(screen.getByRole("button", { name: "Close test Primo" }))
    expect(grid?.className).toContain("lg:grid-cols-[1fr]")
    expect(document.activeElement).toBe(trigger)
  })

  it("keeps the same shell on non-recipe pages", () => {
    state.pathname = "/ingredients"
    render(
      <AppShell
        user={{ id: "1", name: "Ada", email: "ada@example.com" } as SessionUser}
        primoEnabled
      >
        <main>Ingredients</main>
      </AppShell>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open Primo" }))
    expect(screen.getByRole("button", { name: "Close Primo" })).toBeDefined()
  })

  it("hides the header trigger while the inline chat is visible", () => {
    render(
      <AppShell
        user={{ id: "1", name: "Ada", email: "ada@example.com" } as SessionUser}
        primoEnabled
      >
        <InlinePrimo />
      </AppShell>
    )

    expect(screen.queryByRole("button", { name: "Open Primo" })).toBeNull()
  })

  it("hides the header trigger on the home chat route before the chat mounts", () => {
    state.pathname = "/"
    render(
      <AppShell
        user={{ id: "1", name: "Ada", email: "ada@example.com" } as SessionUser}
        primoEnabled
      >
        <main>Loading</main>
      </AppShell>
    )

    expect(screen.queryByRole("button", { name: "Open Primo" })).toBeNull()
  })

  it("keeps the header trigger on Analytics", () => {
    state.pathname = "/analytics"
    render(
      <AppShell
        user={{ id: "1", name: "Ada", email: "ada@example.com" } as SessionUser}
        primoEnabled
      >
        <main>Analytics</main>
      </AppShell>
    )

    expect(screen.getByRole("button", { name: "Open Primo" })).toBeDefined()
  })
})
