"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { useDebouncedCallback } from "@/hooks/use-debounced-callback"

type UrlValue = string | number | null | undefined

/** Short enough that results feel attached to the typing, long enough that a
 * mid-word pause does not fire a request per character. Medusa's admin search
 * sits here too. */
const SEARCH_DEBOUNCE_MS = 500

/**
 * Keeps browse controls shareable and back-button friendly. The server page
 * remains the source of truth for the rows; this hook only writes the next URL.
 */
export function useBrowseUrl({
  query,
  delayMs = SEARCH_DEBOUNCE_MS,
}: {
  query: string
  delayMs?: number
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // The input owns its own text, always. Deriving it from the server-rendered
  // `query` makes every keystroke race the navigation that the previous
  // keystroke started: a commit that lands mid-word snaps the field back to
  // what the server knows and eats the characters typed since. Local state
  // means typing is never blocked on a round trip.
  const [searchValue, setSearchValue] = React.useState(query)
  // What we last wrote to `?q=`. The server moving away from it is someone
  // else's doing — a back/forward, a link — and only then do we adopt it.
  const committedQueryRef = React.useRef(query)
  const [isPending, startTransition] = React.useTransition()
  const paramsRef = React.useRef(searchParams.toString())

  React.useEffect(() => {
    paramsRef.current = searchParams.toString()
  }, [searchParams])

  const replace = React.useCallback(
    (
      changes: Record<string, UrlValue>,
      { resetPage = true }: { resetPage?: boolean } = {}
    ) => {
      // Preserve controls changed during an in-flight navigation. Reading
      // only useSearchParams here can drop the prior change because Next has
      // not committed that URL yet.
      const next = new URLSearchParams(paramsRef.current)
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === undefined || value === "") {
          next.delete(key)
        } else {
          next.set(key, String(value))
        }
      }
      // A control change puts the reader back on the first page, whether the
      // screen pages by number or by offset.
      if (resetPage) {
        for (const key of ["page", "offset"]) {
          if (!(key in changes)) next.delete(key)
        }
      }
      paramsRef.current = next.toString()
      const href = next.size ? `${pathname}?${next}` : pathname
      startTransition(() => router.replace(href, { scroll: false }))
    },
    [pathname, router]
  )

  const commitSearch = useDebouncedCallback((value: string) => {
    const next = value.trim()
    committedQueryRef.current = next
    replace({ q: next || null })
  }, delayMs)

  React.useEffect(() => {
    if (query === committedQueryRef.current) return
    // Someone navigated us: drop the trailing call still holding the old text,
    // then show what the URL now says.
    commitSearch.cancel()
    committedQueryRef.current = query
    setSearchValue(query)
  }, [query, commitSearch])

  const onSearchValueChange = React.useCallback(
    (value: string) => {
      setSearchValue(value)
      commitSearch(value)
    },
    [commitSearch]
  )

  return {
    isPending,
    searchValue,
    onSearchValueChange,
    setOrder: (order: string) => replace({ order }),
    setFilter: (key: string, value: string | null) => replace({ [key]: value }),
    setFilters: (changes: Record<string, string | null>) => replace(changes),
    setPage: (page: number) => replace({ page }, { resetPage: false }),
  }
}
