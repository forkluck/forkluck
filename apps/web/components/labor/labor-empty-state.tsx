"use client"

import * as React from "react"

import { ImportHoursDialog } from "@/components/labor/import-labor-dialog"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/page"

/**
 * Labor before any hours exist: the design's empty card — one hairline, radius
 * 12, 64px of vertical air — saying what the screen becomes and offering the
 * one action that gets there.
 */
export function LaborEmptyState() {
  const [importOpen, setImportOpen] = React.useState(false)

  return (
    <>
      <EmptyState
        title="No hours yet"
        description="Upload the timesheet your clock exports. Forkluck turns it into shifts and real labor cost, employee by employee, and keeps the original rows so any import can be undone."
      >
        <Button onClick={() => setImportOpen(true)}>Import hours</Button>
      </EmptyState>
      <ImportHoursDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  )
}
