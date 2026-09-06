import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({ browseIngredients: vi.fn() }))

vi.mock("@/lib/auth-session", () => ({ requireUser: vi.fn() }))
vi.mock("@/lib/backend/queries", () => backend)
vi.mock("@/lib/backend/client", () => ({
  BackendRequestError: class BackendRequestError extends Error {
    status = 400
  },
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
}))
vi.mock("next/link", () => ({
  default: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/components/ui/page", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  Page: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  PageTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
}))
vi.mock("@/components/ingredients/ingredients-browser", () => ({
  IngredientsBrowser: ({ kind }: { kind: string }) => (
    <div>Ingredients browser: {kind}</div>
  ),
}))

import SuppliesPage from "@/app/(app)/supplies/page"

const emptyPagination = {
  page: 1,
  limit: 50,
  pages: 1,
  total: 0,
  next: null,
  prev: null,
}

describe("supplies page", () => {
  it("browses the supply kind and hands it to the table", async () => {
    backend.browseIngredients.mockResolvedValue({
      items: [],
      meta: { pagination: emptyPagination },
      hasAnyIngredient: true,
    })

    const page = await SuppliesPage({ searchParams: Promise.resolve({}) })
    const markup = renderToStaticMarkup(page)

    expect(backend.browseIngredients).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "supply" })
    )
    expect(markup).toContain("Ingredients browser: supply")
    expect(markup).not.toContain("Track your packaging")
  })

  it("shows onboarding only when the tenant has no supplies", async () => {
    backend.browseIngredients.mockResolvedValue({
      items: [],
      meta: { pagination: emptyPagination },
      hasAnyIngredient: false,
    })

    const page = await SuppliesPage({ searchParams: Promise.resolve({}) })
    const markup = renderToStaticMarkup(page)

    expect(markup).toContain("Track your packaging")
    expect(markup).not.toContain("Ingredients browser")
  })
})
