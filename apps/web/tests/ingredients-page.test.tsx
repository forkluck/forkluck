import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({
  browseIngredients: vi.fn(),
  getIngredientDuplicates: vi.fn(),
  getIngredientImports: vi.fn(),
}))

vi.mock("@/lib/auth-session", () => ({ requireUser: vi.fn() }))
vi.mock("@/lib/backend/queries", () => backend)
vi.mock("@/lib/backend/client", () => ({
  BackendRequestError: class BackendRequestError extends Error {
    status = 400
  },
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))

vi.mock("@/components/ingredients/lazy-import-ingredients-button", () => ({
  LazyImportIngredientsButton: () => <div>Import ingredients</div>,
}))
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
  IngredientsBrowser: () => <div>Ingredients browser</div>,
}))

import IngredientsPage from "@/app/(app)/ingredients/page"

const emptyPagination = {
  page: 1,
  limit: 50,
  pages: 1,
  total: 0,
  next: null,
  prev: null,
}

describe("ingredients page", () => {
  beforeEach(() => {
    backend.getIngredientDuplicates.mockResolvedValue([])
    backend.getIngredientImports.mockResolvedValue([])
  })

  it("keeps the browser visible when a filter has no matches", async () => {
    backend.browseIngredients.mockResolvedValue({
      items: [],
      meta: { pagination: emptyPagination },
      hasAnyIngredient: true,
    })

    const page = await IngredientsPage({
      searchParams: Promise.resolve({ q: "missing" }),
    })
    const markup = renderToStaticMarkup(page)

    expect(markup).toContain("Ingredients browser")
    expect(markup).not.toContain("Price your pantry")
  })

  it("shows onboarding only when the tenant pantry is empty", async () => {
    backend.browseIngredients.mockResolvedValue({
      items: [],
      meta: { pagination: emptyPagination },
      hasAnyIngredient: false,
    })

    const page = await IngredientsPage({ searchParams: Promise.resolve({}) })
    const markup = renderToStaticMarkup(page)

    expect(markup).toContain("Price your pantry")
    expect(markup).not.toContain("Ingredients browser")
  })
})
