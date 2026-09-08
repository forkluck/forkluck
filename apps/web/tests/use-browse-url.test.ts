// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

const replace = vi.fn()
let currentParams = new URLSearchParams()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/products",
  useSearchParams: () => currentParams,
}))

const { useBrowseUrl } = await import("@/hooks/use-browse-url")

/**
 * The server page rendering the URL we just wrote. Real navigations are a
 * round trip, so the test drives the two halves separately: `commit` fires the
 * debounce, `land` delivers the new `query` prop some time later.
 */
function browsing(query = "") {
  const view = renderHook((props: { query: string }) => useBrowseUrl(props), {
    initialProps: { query },
  })
  return {
    get value() {
      return view.result.current.searchValue
    },
    type(value: string) {
      act(() => view.result.current.onSearchValueChange(value))
    },
    commit() {
      act(() => vi.runAllTimers())
    },
    land(nextQuery: string) {
      currentParams = new URLSearchParams(nextQuery ? { q: nextQuery } : {})
      view.rerender({ query: nextQuery })
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  currentParams = new URLSearchParams()
  replace.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe("a filter pill that writes to the URL", () => {
  it("writes to the page it is on, keeps other keys, and drops defaults", () => {
    currentParams = new URLSearchParams({
      page: "3",
      comparison: "prior_year",
      order: "title",
    })
    const view = renderHook(() => useBrowseUrl({ query: "" }))
    act(() =>
      view.result.current.setFilters({
        start: "2026-08-01",
        end: null,
        comparison: null,
        date: null,
      })
    )
    // The page resets, the null keys leave, the order the pill never touched
    // stays, and the path is the page's own.
    expect(replace).toHaveBeenCalledWith(
      "/products?order=title&start=2026-08-01",
      {
        scroll: false,
      }
    )
  })
})

describe("typing in a table's search box", () => {
  it("writes the URL once the typing stops, not once per keystroke", () => {
    const browse = browsing()
    browse.type("c")
    browse.type("ch")
    browse.type("chi")
    expect(replace).not.toHaveBeenCalled()

    browse.commit()
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith("/products?q=chi", { scroll: false })
  })

  it("keeps characters typed while the previous search is still in flight", () => {
    const browse = browsing()
    browse.type("chick")
    browse.commit()

    // The user keeps going before the server answers.
    browse.type("chicken s")
    // ...and now the earlier navigation lands.
    browse.land("chick")

    expect(browse.value).toBe("chicken s")
  })

  it("does not roll the field back when its own search lands", () => {
    const browse = browsing()
    browse.type("stock")
    browse.commit()
    browse.land("stock")

    expect(browse.value).toBe("stock")
  })

  it("follows the URL when the user navigates back", () => {
    const browse = browsing()
    browse.type("stock")
    browse.commit()
    browse.land("stock")

    // Back button: a query we never typed.
    act(() => browse.land(""))
    expect(browse.value).toBe("")
  })

  it("drops a pending keystroke that a back navigation has overtaken", () => {
    const browse = browsing()
    browse.type("stock")
    browse.commit()
    browse.land("stock")
    replace.mockClear()

    browse.type("stockpot")
    act(() => browse.land("")) // back fires before the debounce does
    browse.commit()

    expect(browse.value).toBe("")
    expect(replace).not.toHaveBeenCalled()
  })

  it("clears ?q= rather than writing an empty one", () => {
    const browse = browsing("stock")
    browse.type("")
    browse.commit()

    expect(replace).toHaveBeenCalledWith("/products", { scroll: false })
  })
})
