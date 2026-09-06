import { Database } from "lucide-react"

import { Badge } from "@/components/ui/badge"

export type PrimoUsdaSearchResult = {
  query: string
  scope: "common" | "branded"
  items: {
    fdcId: number
    description: string
    dataType: string
    brand: string
  }[]
}

export function PrimoUsdaResultCard({
  result,
}: {
  result: PrimoUsdaSearchResult
}) {
  const scopeLabel = result.scope === "branded" ? "Branded" : "Common"

  return (
    <section
      aria-label={`USDA matches for ${result.query}`}
      className="w-full rounded-xl border border-border bg-card"
    >
      <div className="border-b border-border px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-md leading-5 font-medium text-foreground">
            <Database className="size-3.5 shrink-0" aria-hidden="true" />
            <span>USDA FoodData Central</span>
          </div>
          <Badge size="row">{scopeLabel}</Badge>
        </div>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
          Candidate matches for “{result.query}”. Check the description before
          using a record.
        </p>
      </div>

      <div className="px-4 py-4">
        {result.items.length ? (
          <ul className="divide-y divide-border border-y border-border">
            {result.items.map((item) => (
              <li key={item.fdcId} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      {item.description}
                    </p>
                    <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                      {item.dataType || "USDA food"} · FDC {item.fdcId}
                    </p>
                  </div>
                  {item.brand ? (
                    <Badge
                      size="row"
                      className="max-w-28 truncate rounded-sm px-[7px] text-2xs"
                      title={item.brand}
                    >
                      {item.brand}
                    </Badge>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-md leading-5 text-muted-foreground">
            No {result.scope} USDA foods matched “{result.query}”. Try broader
            wording.
          </p>
        )}
      </div>
    </section>
  )
}
