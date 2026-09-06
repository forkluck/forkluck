"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"

import { GuestPage } from "@/components/recipes/guest-page"
import { formatYield, RecipeSheet } from "@/components/recipes/recipe-sheet"
import { Button } from "@/components/ui/button"
import type { GuestBook } from "@/lib/backend/types"

/**
 * Several shared recipes on one page: a line per recipe, each opening into the
 * sheet a single share shows, at its own batch. Every sheet stays mounted, so
 * a reader can scale one entry and come back to it.
 */
export function GuestBookView({ book }: { book: GuestBook }) {
  // One recipe has nothing to choose between, so it opens on arrival.
  const [open, setOpen] = React.useState<Set<number>>(
    () => new Set(book.recipes.length === 1 ? [0] : [])
  )
  const allOpen = open.size === book.recipes.length

  return (
    <GuestPage>
      <div className="grid gap-2">
        <h1 className="text-3xl leading-tight font-semibold tracking-[-0.01em]">
          {book.title}
        </h1>
        <p className="text-base text-muted-foreground">
          Shared by {book.ownerName}
        </p>
        {book.role === "editor" ? (
          <p className="mt-2 text-md">
            You&apos;re invited to edit these recipes. Create an account with
            the address this link was sent to and they will be waiting in your
            kitchen.
          </p>
        ) : null}
      </div>

      <div className="grid gap-3">
        {/* A closed entry does not print, so paper needs one press first. */}
        <Button
          variant="outline"
          size="sm"
          className="w-fit print:hidden"
          onClick={() =>
            setOpen(
              allOpen ? new Set() : new Set(book.recipes.map((_, at) => at))
            )
          }
        >
          {allOpen ? "Close all" : "Open all"}
        </Button>
        {book.recipes.map((recipe, index) => (
          <details
            key={index}
            open={open.has(index)}
            className="group/entry rounded-xl border border-border px-4 py-3"
          >
            <summary
              className="flex list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-brand/30"
              // jsdom never activates a summary, and the open state is React's
              // to hold anyway.
              onClick={(event) => {
                event.preventDefault()
                setOpen((current) => {
                  const next = new Set(current)
                  if (!next.delete(index)) next.add(index)
                  return next
                })
              }}
            >
              <ChevronRight
                className="size-4 flex-none text-muted-foreground group-open/entry:rotate-90"
                strokeWidth={2}
                aria-hidden="true"
              />
              <h2 className="text-lg font-semibold">{recipe.title}</h2>
              {/* At 1x, so the line does not move while the sheet scales. */}
              {recipe.yieldAmount !== null ? (
                <span className="text-base text-muted-foreground tabular-nums">
                  Makes {formatYield(recipe.yieldAmount, recipe.yieldUnit)}
                </span>
              ) : null}
            </summary>
            <div className="mt-5 grid gap-8">
              <RecipeSheet recipe={recipe} />
            </div>
          </details>
        ))}
      </div>
    </GuestPage>
  )
}
