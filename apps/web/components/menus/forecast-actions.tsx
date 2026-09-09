"use client"

import { Printer, Upload } from "lucide-react"

import { ActionsMenu } from "@/components/ui/actions-menu"
import { MenuItem } from "@/components/ui/menu"
import type { MenuForecast } from "@/lib/backend/types"

import {
  downloadCsv,
  exportFileName,
  prepListCsv,
  shoppingListCsv,
} from "@/components/menus/forecast-export"

/**
 * What a forecast can do besides be read: go to the printer as one page, or
 * leave as the two lists a kitchen works from. The print hides the app's
 * chrome and these controls through the shell's `print:hidden` rules.
 */
export function ForecastActions({ forecast }: { forecast: MenuForecast }) {
  return (
    <ActionsMenu>
      <MenuItem onClick={() => window.print()}>
        <Printer strokeWidth={1.8} aria-hidden="true" />
        Print forecast
      </MenuItem>
      <MenuItem
        onClick={() =>
          downloadCsv(
            shoppingListCsv(forecast),
            exportFileName(forecast, "shopping-list")
          )
        }
      >
        <Upload strokeWidth={1.8} aria-hidden="true" />
        Export shopping list
      </MenuItem>
      <MenuItem
        onClick={() =>
          downloadCsv(
            prepListCsv(forecast),
            exportFileName(forecast, "prep-list")
          )
        }
      >
        <Upload strokeWidth={1.8} aria-hidden="true" />
        Export prep list
      </MenuItem>
    </ActionsMenu>
  )
}
