import { Columns3, Eye, EyeOff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { cn } from "@/lib/utils"

export type ColumnChoice = {
  id: string
  label: string
  visible: boolean
  onToggle: (visible: boolean) => void
}

/** Hides and restores columns — the same menu on every table. */
export function ColumnsMenu({ columns }: { columns: ColumnChoice[] }) {
  const hiddenCount = columns.filter((column) => !column.visible).length
  if (columns.length === 0) return null
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="icon" />}
        aria-label={hiddenCount ? `Columns, ${hiddenCount} hidden` : "Columns"}
      >
        <Columns3 strokeWidth={1.8} aria-hidden="true" />
      </MenuTrigger>
      <MenuContent className="w-[212px]">
        <div className="px-2.5 pt-1 pb-1.5 text-2xs leading-none font-medium text-faint">
          Columns
        </div>
        {columns.map((column) => (
          <MenuItem
            key={column.id}
            closeOnClick={false}
            onClick={() => column.onToggle(!column.visible)}
            className={cn(
              "justify-between font-normal",
              !column.visible && "text-muted-foreground"
            )}
          >
            {column.label}
            {column.visible ? (
              <Eye strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <EyeOff strokeWidth={1.8} aria-hidden="true" />
            )}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
