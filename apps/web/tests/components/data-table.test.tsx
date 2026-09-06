// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { DataTable, dataTableColumns } from "@/components/ui/data-table"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { MenuItem } from "@/components/ui/menu"

afterEach(cleanup)

type Row = { id: string; name: string; count: number }

const rows: Row[] = [{ id: "1", name: "Linzer", count: 3 }]

const helper = dataTableColumns<Row>()

function columns(withActions: boolean) {
  const base = [
    helper.accessor("name", { id: "name", header: "Name" }),
    helper.accessor("count", { id: "count", header: "Count" }),
  ]
  if (!withActions) return base
  return [
    ...base,
    helper.display({
      id: "actions",
      cell: ({ row }) => (
        <RowActionsMenu label={`Actions for ${row.original.name}`}>
          <MenuItem>Edit</MenuItem>
        </RowActionsMenu>
      ),
    }),
  ]
}

function actionsCell() {
  return screen
    .getByRole("button", { name: "Actions for Linzer" })
    .closest("td")!
}

describe("DataTable", () => {
  it("pins a trailing actions column to the right edge", () => {
    render(<DataTable columns={columns(true)} data={rows} />)
    const cell = actionsCell()
    expect(cell.className).toContain("sticky")
    expect(cell.className).toContain("right-0")
    // The hairline only appears once the table has somewhere left to scroll,
    // and jsdom reports no overflow.
    expect(cell.className).toContain("before:bg-transparent")
  })

  it("leaves the actions column unpinned when the screen opts out", () => {
    render(
      <DataTable
        columns={columns(true)}
        data={rows}
        stickyActionsColumn={false}
      />
    )
    expect(actionsCell().className).not.toContain("right-0")
  })
})
