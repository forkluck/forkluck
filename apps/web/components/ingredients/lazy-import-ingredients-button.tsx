"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { Download } from "lucide-react"

import { IngredientOptionsLoadingDialog } from "@/components/ingredients/ingredient-options-loading-dialog"
import { Button } from "@/components/ui/button"
import { useIngredientOptions } from "@/hooks/use-ingredient-options"

// Its own boundary, so a chunk still on its way never suspends up to the
// route's full-page spinner; reaching for the button fetches it early.
const ImportIngredientsDialog = dynamic(
  () =>
    import("@/components/ingredients/import-dialog").then(
      (module) => module.ImportIngredientsDialog
    ),
  { loading: () => null }
)
const prefetchImport = () =>
  void import("@/components/ingredients/import-dialog")

export function LazyImportIngredientsButton() {
  const [open, setOpen] = React.useState(false)
  const { options, status, load } = useIngredientOptions()

  const show = () => {
    setOpen(true)
    void load()
  }

  return (
    <>
      <Button
        variant="outline"
        onPointerEnter={prefetchImport}
        onFocus={prefetchImport}
        onClick={show}
      >
        <Download strokeWidth={1.8} aria-hidden="true" />
        Import ingredients
      </Button>
      {open && status === "ready" ? (
        <ImportIngredientsDialog
          ingredients={options}
          open
          onOpenChange={setOpen}
        />
      ) : open ? (
        <IngredientOptionsLoadingDialog
          open
          error={status === "error"}
          onOpenChange={setOpen}
          onRetry={() => void load()}
        />
      ) : null}
    </>
  )
}
