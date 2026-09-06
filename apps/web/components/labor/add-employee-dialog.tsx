"use client"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * Add employee — the 430px small form.
 *
 * Forkluck has no separate employee roster: people enter the system through
 * the hours you import, and an employee with no shift has nothing to cost. So
 * this says that in one sentence and hands over to the import, rather than
 * offering a name field that would create a row nothing could ever fill.
 */
export function AddEmployeeDialog({
  open,
  onOpenChange,
  onImportHours,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImportHours: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add employee</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Employees come from the hours you import. Every name in a timesheet
          becomes an employee here, with a rate you can set before the import is
          saved or any time after.
        </DialogDescription>
        <div className="mt-0.5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onImportHours}>Import hours</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
