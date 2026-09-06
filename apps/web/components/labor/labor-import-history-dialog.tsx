"use client"

import { undoLaborImport } from "@/app/(app)/labor/actions"
import { formatDecimalHours } from "@/components/labor/labor-format"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useUndoImport } from "@/hooks/use-undo-import"
import { formatCents } from "@/lib/money"
import type { LaborImportRow } from "@/lib/backend/types"
import { formatDateTime } from "@/lib/datetime"

/**
 * Import history — the 470px standard modal. Every upload keeps its source
 * totals; only the newest active import can be undone, so work added after it
 * is never quietly rolled back with it.
 */
export function LaborImportHistoryDialog({
  imports,
  open,
  onOpenChange,
}: {
  imports: LaborImportRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { currencyCode, timezone } = useBusinessSettings()
  const { armedId, pendingId, error, undo } = useUndoImport(undoLaborImport, {
    refresh: false,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import history</DialogTitle>
        </DialogHeader>

        <div>
          {imports.length === 0 ? (
            <p className="text-base leading-[1.6] text-muted-foreground">
              No hours have been imported yet.
            </p>
          ) : (
            <div className="max-h-[60dvh] overflow-auto border-t border-muted">
              {imports.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 border-b border-muted py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-md">{item.fileName}</p>
                      {item.undoneAt ? <Badge>Undone</Badge> : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDateTime(item.createdAt, timezone)} ·{" "}
                      {item.importedCount} shifts ·{" "}
                      {formatDecimalHours(item.totalSeconds)} h ·{" "}
                      {formatCents(item.totalLaborCostCents, currencyCode)}
                    </p>
                  </div>
                  {item.canUndo ? (
                    <Button
                      variant={armedId === item.id ? "destructive" : "outline"}
                      disabled={pendingId !== null}
                      onClick={() => void undo(item.id)}
                    >
                      {pendingId === item.id
                        ? "Undoing…"
                        : armedId === item.id
                          ? "Confirm undo"
                          : "Undo"}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {error ? (
            <p
              className="mt-3 text-xs leading-[1.55] text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-0.5 flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
