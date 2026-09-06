"use client"

import * as React from "react"
import { Waypoints } from "lucide-react"

import { Switch } from "@/components/ui/switch"
import { setProductMatching } from "@/app/(app)/settings/actions"
import { useCommit } from "@/hooks/use-commit"

/**
 * The switch is the whole interaction, so the row is not a button: wrapping a
 * switch in a button would nest two controls. The card heading names the
 * setting, so the row carries only what it does.
 *
 * Optimistic: the switch answers immediately and rolls back if the server
 * refuses, because linking a large catalog is not instant and a switch that
 * sits still reads as broken.
 */
export function ProductMatchingRow({ initial }: { initial: boolean }) {
  const describedBy = React.useId()
  const [checked, setChecked] = React.useState(initial)
  const [error, setError] = React.useState<string | null>(null)
  const commit = useCommit({})

  function onCheckedChange(next: boolean) {
    const previous = checked
    void commit({
      domain: "workspace:product-matching",
      apply: () => {
        setChecked(next)
        setError(null)
      },
      revert: () => setChecked(previous),
      write: () => setProductMatching(next),
    }).then((failure) => setError(failure ? failure.message : null))
  }

  return (
    <section className="mt-[26px] max-w-[760px]">
      <h2 className="text-md font-semibold text-foreground">
        Product matching
      </h2>
      <div className="mt-2.5 overflow-hidden rounded-xl border border-border">
        <div className="flex w-full items-center gap-3 px-4 py-3.5">
          <span className="flex w-[17px] flex-none items-center justify-center text-muted-foreground">
            <Waypoints
              className="size-[17px]"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </span>
          <span
            id={describedBy}
            className="min-w-0 flex-1 text-md text-foreground"
          >
            Applies each tracked SKU to every catalog item carrying it.
          </span>
          <Switch
            checked={checked}
            onCheckedChange={onCheckedChange}
            aria-label="Product matching"
            aria-describedby={describedBy}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-base text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
