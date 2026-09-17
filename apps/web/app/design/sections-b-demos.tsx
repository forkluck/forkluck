"use client"

import * as React from "react"
import { Clock, Download, SquarePen, Trash2, Upload } from "lucide-react"

import { UnitCombobox } from "@/components/ingredients/unit-combobox"
import { ActionsMenu } from "@/components/ui/actions-menu"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { ColorField } from "@/components/ui/color-field"
import { ColorPicker } from "@/components/ui/color-picker"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DateField } from "@/components/ui/date-field"
import type { UnitOption } from "@/lib/unit-registry"
import { DateRangeFilter } from "@/components/ui/date-range-filter"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { DropZone } from "@/components/ui/drop-zone"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field"
import {
  Input,
  InputAffix,
  InputGroup,
  SearchInput,
} from "@/components/ui/input"
import { LabeledInput, LabeledShell } from "@/components/ui/labeled-field"
import { MenuCheckItem, MenuItem } from "@/components/ui/menu"
import { MetricCard, Stat } from "@/components/ui/metric-card"
import { MetricComparisonBadge } from "@/components/ui/metric-comparison-badge"
import { MonthGrid } from "@/components/ui/month-grid"
import { EmptyState } from "@/components/ui/page"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { RadioGroup, RadioItem } from "@/components/ui/radio-group"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableFrame,
  TableHead,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table"

/**
 * Every demo body for sections 27 to 51 of the visual guide: the app's own
 * components on kitchen data, one component per pane.
 *
 * This is the client half of the registry. The list itself lives in
 * `sections-b.tsx`, which stays a server module so the page can read it: in
 * RSC every export of a "use client" module becomes a client reference, and a
 * server component mapping over an array imported from one would throw.
 *
 * Nothing here talks to the server, the router or the clock. A demo that needs
 * state keeps it in this file, and the one date field is pinned to UTC on a
 * fixed day so the page renders the same thing every time.
 */

/** The pane's own vertical rhythm, shared by every demo that stacks rows. */
const PANE_STACK = "flex flex-col gap-4"

export function EmailFieldDemo() {
  return (
    <div className="flex max-w-80 flex-col gap-4">
      <LabeledInput
        label="Billing email"
        type="email"
        defaultValue="orders@ternbakery.com"
        autoComplete="off"
      />
      <LabeledInput
        label="Invoice inbox"
        type="email"
        placeholder="invoices@yourkitchen.com"
        autoComplete="off"
      />
    </div>
  )
}

export function PasswordFieldDemo() {
  return (
    <div className="flex max-w-80 flex-col gap-2">
      <LabeledInput
        label="Password"
        type="password"
        defaultValue="sourdough-starter"
        autoComplete="off"
      />
      <FieldDescription>
        At least 10 characters. Used for the kitchen account, not the supplier
        portal.
      </FieldDescription>
    </div>
  )
}

export function UrlFieldDemo() {
  return (
    <LabeledShell label="Supplier portal" className="max-w-80">
      <InputGroup>
        <InputAffix>https://</InputAffix>
        <Input
          type="url"
          defaultValue="baldor.com/orders"
          autoComplete="off"
          spellCheck={false}
          className="pl-[62px]"
        />
      </InputGroup>
    </LabeledShell>
  )
}

export function SearchFieldDemo() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SearchInput label="Search ingredients" />
      <SearchInput
        label="Search recipes"
        defaultValue="croissant"
        className="max-w-[196px]"
      />
    </div>
  )
}

const UNIT_OPTIONS: UnitOption[] = [
  { slug: "g", label: "Gram", heading: "Weight" },
  { slug: "kg", label: "Kilogram", heading: "Weight" },
  { slug: "lb", label: "Pound", heading: "Weight" },
  { slug: "ml", label: "Millilitre", heading: "Volume" },
  { slug: "l", label: "Litre", heading: "Volume" },
  { slug: "each", label: "Each", heading: "Count" },
  { slug: "case", label: "Case", heading: "Count" },
]

/** The searchable combobox beside the plain select: type to filter units. */
function UnitComboboxDemo() {
  const [unit, setUnit] = React.useState<string | null>("kg")
  return (
    <div className="w-56">
      <UnitCombobox
        id="guide-unit"
        label="Unit"
        value={unit}
        onChange={setUnit}
        options={UNIT_OPTIONS}
      />
    </div>
  )
}

export function SelectDemo() {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <LabeledShell label="Purchase unit" className="w-56">
        <Select defaultValue="Kilogram">
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Weight</SelectLabel>
              <SelectItem value="Kilogram">Kilogram</SelectItem>
              <SelectItem value="Pound">Pound</SelectItem>
              <SelectItem value="Ounce">Ounce</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Volume</SelectLabel>
              <SelectItem value="Litre">Litre</SelectItem>
              <SelectItem value="Quart">Quart</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Count</SelectLabel>
              <SelectItem value="Case">Case</SelectItem>
              <SelectItem value="Each">Each</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </LabeledShell>
      <Select defaultValue="Bakery">
        <SelectTrigger size="sm" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="Bakery">Bakery</SelectItem>
          <SelectItem value="Pastry">Pastry</SelectItem>
          <SelectItem value="Larder">Larder</SelectItem>
        </SelectContent>
      </Select>
      <UnitComboboxDemo />
    </div>
  )
}

export function DateFieldDemo() {
  const [value, setValue] = React.useState("2026-09-16")
  return (
    <div className="max-w-64">
      <DateField
        id="guide-date-field"
        label="Delivery date"
        value={value}
        onChange={setValue}
        timeZone="UTC"
      />
    </div>
  )
}

export function DatePickerDemo() {
  const [day, setDay] = React.useState("2026-09-16")
  const [range, setRange] = React.useState<{
    startDate: string | null
    endDate: string | null
  }>({ startDate: "2026-09-01", endDate: "2026-09-16" })

  return (
    <div className={PANE_STACK}>
      <div className="w-[19rem] rounded-lg border border-border bg-card p-3">
        <p className="text-md font-semibold">September 2026</p>
        <MonthGrid
          month={new Date(Date.UTC(2026, 8, 1))}
          today="2026-09-16"
          decorate={(date) => ({ selected: date === day })}
          onSelectDate={setDay}
        />
      </div>
      <DateRangeFilter
        selectedStartDate={range.startDate}
        selectedEndDate={range.endDate}
        timeZone="UTC"
        onSelectedDateRangeChange={(startDate, endDate) =>
          setRange({ startDate, endDate })
        }
        onClear={() => setRange({ startDate: null, endDate: null })}
        className="w-fit"
      />
    </div>
  )
}

export function ColorFieldDemo() {
  const [color, setColor] = React.useState("#3273dc")
  return (
    <div className="max-w-64">
      <ColorField label="Chart color" value={color} onValueChange={setColor} />
    </div>
  )
}

export function ColorPickerDemo() {
  const [color, setColor] = React.useState("#2f7a4f")
  return <ColorPicker value={color} onValueChange={setColor} />
}

export function DropZoneDemo() {
  const [names, setNames] = React.useState<string[]>([])
  return (
    <div className={PANE_STACK}>
      <DropZone
        accept="application/pdf"
        multiple
        onFiles={(files) => setNames(files.map((file) => file.name))}
      >
        PDF invoices, up to 5 MB each
      </DropZone>
      <p className="text-xs text-muted-foreground">
        {names.length > 0 ? names.join(", ") : "No files chosen yet."}
      </p>
    </div>
  )
}

export function CheckboxDemo() {
  return (
    <div className="flex flex-col gap-3">
      <Field orientation="horizontal">
        <Checkbox id="guide-check-flour" />
        <FieldLabel htmlFor="guide-check-flour">Bread flour</FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Checkbox id="guide-check-butter" defaultChecked />
        <FieldLabel htmlFor="guide-check-butter">European butter</FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Checkbox id="guide-check-all" indeterminate />
        <FieldLabel htmlFor="guide-check-all">All dairy</FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Checkbox id="guide-check-archived" disabled />
        <FieldLabel htmlFor="guide-check-archived">
          Archived ingredients
        </FieldLabel>
      </Field>
      <Field orientation="horizontal" data-invalid="true">
        <Checkbox id="guide-check-terms" aria-invalid />
        <FieldLabel htmlFor="guide-check-terms">Supplier terms</FieldLabel>
      </Field>
      <FieldError>Accept the supplier terms to place the order.</FieldError>
    </div>
  )
}

export function ChoiceListDemo() {
  const [basis, setBasis] = React.useState("yield")
  return (
    <div className="flex flex-wrap gap-10">
      <FieldSet>
        <FieldLegend variant="label">Costing basis</FieldLegend>
        <RadioGroup
          aria-label="Costing basis"
          value={basis}
          onValueChange={(next) => setBasis(next as string)}
        >
          <RadioItem value="yield">Yield cost</RadioItem>
          <RadioItem value="purchase">Purchase cost</RadioItem>
          <RadioItem value="invoice" disabled>
            Last invoice price
          </RadioItem>
        </RadioGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend variant="label">Include in the export</FieldLegend>
        <div data-slot="checkbox-group" className="flex flex-col gap-3">
          <Field orientation="horizontal">
            <Checkbox id="guide-export-recipes" defaultChecked />
            <FieldLabel htmlFor="guide-export-recipes">Recipes</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="guide-export-ingredients" defaultChecked />
            <FieldLabel htmlFor="guide-export-ingredients">
              Ingredients
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="guide-export-invoices" />
            <FieldLabel htmlFor="guide-export-invoices">Invoices</FieldLabel>
          </Field>
        </div>
      </FieldSet>
    </div>
  )
}

export function SwitchDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Field orientation="horizontal">
        <Switch id="guide-switch-costs" defaultChecked />
        <FieldLabel htmlFor="guide-switch-costs">
          Show costs on the recipe
        </FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Switch id="guide-switch-waste" />
        <FieldLabel htmlFor="guide-switch-waste">
          Apply a waste allowance
        </FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Switch id="guide-switch-sync" size="sm" defaultChecked />
        <FieldLabel htmlFor="guide-switch-sync">
          Sync sales every night
        </FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Switch id="guide-switch-locked" disabled />
        <FieldLabel htmlFor="guide-switch-locked">
          Lock prices to the last invoice
        </FieldLabel>
      </Field>
    </div>
  )
}

const TABLE_ROWS = [
  { name: "Butter croissant", cost: "$1.14", margin: "68%", status: "Costed" },
  { name: "Pain au chocolat", cost: "$1.42", margin: "63%", status: "Costed" },
  { name: "Almond frangipane", cost: "$2.06", margin: "54%", status: "Review" },
]

export function TableDemo() {
  return (
    <div className={PANE_STACK}>
      <TableFrame>
        <Table>
          <TableHeader>
            <TableHeaderRow>
              <TableHead>Recipe</TableHead>
              <TableHead className="text-right">Cost per unit</TableHead>
              <TableHead className="text-right">Margin</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-12" />
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {TABLE_ROWS.map((row) => (
              <TableRow key={row.name}>
                <TableCell>{row.name}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.cost}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.margin}
                </TableCell>
                <TableCell>
                  <Badge
                    size="row"
                    variant={row.status === "Costed" ? "success" : "warning"}
                  >
                    {row.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <RowActionsMenu label={`Actions for ${row.name}`}>
                    <MenuItem>
                      <SquarePen strokeWidth={1.8} aria-hidden="true" />
                      Edit
                    </MenuItem>
                    <MenuItem className="text-destructive">
                      <Trash2 strokeWidth={1.8} aria-hidden="true" />
                      Delete
                    </MenuItem>
                  </RowActionsMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableFrame>
      <TableFrame>
        <Table>
          <TableHeader>
            <TableHeaderRow>
              <TableHead>Supplier</TableHead>
              <TableHead className="text-right">Invoices</TableHead>
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            <TableEmpty colSpan={2}>No suppliers match this filter.</TableEmpty>
          </TableBody>
        </Table>
      </TableFrame>
    </div>
  )
}

export function DividerDemo() {
  return (
    <div className={PANE_STACK}>
      <div className="flex flex-col gap-3">
        <p className="text-base">Yield 24 croissants</p>
        <Separator />
        <p className="text-base">Batch time 3 h 20 m</p>
      </div>
      <div className="flex h-5 items-center gap-3 text-base">
        <span>Bakery</span>
        <Separator orientation="vertical" />
        <span>Pastry</span>
        <Separator orientation="vertical" />
        <span>Larder</span>
      </div>
      <div className="flex flex-col gap-3">
        <FieldSeparator>or</FieldSeparator>
      </div>
    </div>
  )
}

export function BoxDemo() {
  return (
    <div className={PANE_STACK}>
      <Card>
        <CardHeader>
          <CardTitle>Butter croissant</CardTitle>
          <CardDescription>Updated this morning</CardDescription>
        </CardHeader>
        <CardContent>
          Twelve components, costed from last week&apos;s invoices.
        </CardContent>
      </Card>
      <Card className="gap-2 p-3">
        <CardTitle>Tighter padding</CardTitle>
        <CardContent>The same surface with 12px of padding.</CardContent>
      </Card>
      <div className="flex flex-wrap gap-3">
        <div className="rounded-lg bg-fill-soft px-4 py-3 text-base">
          bg-fill-soft, the quiet panel
        </div>
        <div className="rounded-lg bg-secondary px-4 py-3 text-base">
          bg-secondary, the grey fill
        </div>
      </div>
    </div>
  )
}

export function StackDemo() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-base">Bread flour</p>
        <p className="text-base">European butter</p>
        <p className="text-base">Sea salt</p>
      </div>
      <div className="flex flex-col gap-4">
        <p className="text-base">Mix and rest</p>
        <p className="text-base">Laminate</p>
        <p className="text-base">Proof and bake</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline">Cancel</Button>
        <Button>Save recipe</Button>
      </div>
    </div>
  )
}

export function GridDemo() {
  return (
    <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Components</CardTitle>
          <CardDescription>
            Twelve ingredients and two preparations
          </CardDescription>
        </CardHeader>
        <CardContent>
          The wide column carries the table on a detail screen.
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Costing</CardTitle>
          <CardDescription>Yield basis</CardDescription>
        </CardHeader>
        <CardContent>The narrow column carries the summary.</CardContent>
      </Card>
    </div>
  )
}

const SUPPLIERS = [
  "Baldor Specialty Foods",
  "Cream Co. Dairy",
  "Hudson Valley Mills",
  "Maison Beurre",
  "Nordic Sea Salt",
  "Old Chatham Creamery",
  "Regalis Foods",
  "Sullivan Street Grains",
  "Terra Nova Produce",
  "Valrhona",
]

export function ScrollBoxDemo() {
  return (
    <ScrollArea className="h-48 w-full max-w-80 rounded-md border border-border">
      <div className="flex flex-col gap-2 p-3">
        {SUPPLIERS.map((supplier) => (
          <p key={supplier} className="text-base">
            {supplier}
          </p>
        ))}
      </div>
    </ScrollArea>
  )
}

export function QueryContainerDemo() {
  return (
    <div className="@container w-full rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 @md:flex-row @md:items-center">
        <SearchInput label="Search invoices" className="@md:max-w-[196px]" />
        <div className="flex items-center gap-2 @md:ml-auto">
          <Button variant="outline">Export</Button>
          <Button>Add invoice</Button>
        </div>
      </div>
    </div>
  )
}

export function PopoverDemo() {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline">Columns</Button>} />
      <PopoverContent className="w-56">
        <div className="flex flex-col gap-3">
          <p className="text-2xs font-medium text-faint">Visible columns</p>
          <Field orientation="horizontal">
            <Checkbox id="guide-column-cost" defaultChecked />
            <FieldLabel htmlFor="guide-column-cost">Cost per unit</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="guide-column-margin" defaultChecked />
            <FieldLabel htmlFor="guide-column-margin">Margin</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="guide-column-allergens" />
            <FieldLabel htmlFor="guide-column-allergens">Allergens</FieldLabel>
          </Field>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function MenuDemo() {
  const [sort, setSort] = React.useState("name")
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ActionsMenu>
        <MenuItem>
          <Download strokeWidth={1.8} aria-hidden="true" />
          Import recipes
        </MenuItem>
        <MenuItem>
          <Upload strokeWidth={1.8} aria-hidden="true" />
          Export recipes
        </MenuItem>
        <MenuItem>
          <Clock strokeWidth={1.8} aria-hidden="true" />
          History
        </MenuItem>
      </ActionsMenu>
      <ActionsMenu label="Sort">
        <MenuCheckItem
          checked={sort === "name"}
          onClick={() => setSort("name")}
        >
          Name
        </MenuCheckItem>
        <MenuCheckItem
          checked={sort === "cost"}
          onClick={() => setSort("cost")}
        >
          Cost per unit
        </MenuCheckItem>
        <MenuCheckItem
          checked={sort === "margin"}
          onClick={() => setSort("margin")}
        >
          Margin
        </MenuCheckItem>
      </ActionsMenu>
      <RowActionsMenu label="Actions for Butter croissant">
        <MenuItem>
          <SquarePen strokeWidth={1.8} aria-hidden="true" />
          Edit
        </MenuItem>
        <MenuItem className="text-destructive">
          <Trash2 strokeWidth={1.8} aria-hidden="true" />
          Delete
        </MenuItem>
      </RowActionsMenu>
    </div>
  )
}

export function ModalDemo() {
  const [confirming, setConfirming] = React.useState(false)
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Dialog>
        <DialogTrigger
          render={<Button variant="outline">Open the dialog</Button>}
        />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Duplicate recipe</DialogTitle>
            <DialogDescription>
              The copy keeps every component and its yield. Costs recalculate
              from today&apos;s prices.
            </DialogDescription>
          </DialogHeader>
          <LabeledInput
            label="New name"
            defaultValue="Butter croissant (copy)"
            autoComplete="off"
          />
          <DialogFooter showCloseButton>
            <Button>Duplicate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Button variant="destructive" onClick={() => setConfirming(true)}>
        Delete recipe
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete Butter croissant?"
        description="Twelve components and every costing on this recipe go with it."
        confirmLabel="Delete recipe"
        confirmText="croissant"
        onConfirm={() => setConfirming(false)}
      />
    </div>
  )
}

export function EmptyStateDemo() {
  return (
    <div className={PANE_STACK}>
      <EmptyState
        title="No ingredients yet"
        description="Add the things you buy, then build recipes on top of them. An invoice import fills this list in one pass."
      >
        <Button>Add an ingredient</Button>
        <Button variant="ghost">Import from an invoice</Button>
      </EmptyState>
      <TableFrame>
        <Table>
          <TableHeader>
            <TableHeaderRow>
              <TableHead>Ingredient</TableHead>
              <TableHead className="text-right">Last price</TableHead>
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            <TableEmpty colSpan={2}>
              No ingredients match this search.
            </TableEmpty>
          </TableBody>
        </Table>
      </TableFrame>
    </div>
  )
}

export function NumberDemo() {
  return (
    <div className={PANE_STACK}>
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricCard
          label="Food cost"
          value="31.4%"
          badge={
            <MetricComparisonBadge
              current={31.4}
              previous={33.8}
              lowerIsBetter
              label="Food cost against the prior week"
            />
          }
          note="Against 33.8% the week before"
        />
        <MetricCard
          label="Net sales"
          value="$18,420"
          badge={
            <MetricComparisonBadge
              current={18420}
              previous={17110}
              label="Net sales against the prior week"
            />
          }
          note="Against $17,110 the week before"
        />
      </div>
      <p className="text-4xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
        $1.14
      </p>
      <dl className="flex flex-wrap gap-8">
        <Stat label="Components" value="12" />
        <Stat label="Yield" value="24" />
        <Stat label="Batch cost" value="$27.36" />
      </dl>
      <div className="flex max-w-56 flex-col gap-1 text-base tabular-nums">
        <div className="flex justify-between">
          <span>Bread flour</span>
          <span>$4.20</span>
        </div>
        <div className="flex justify-between">
          <span>European butter</span>
          <span>$18.75</span>
        </div>
        <div className="flex justify-between">
          <span>Sea salt</span>
          <span>$0.41</span>
        </div>
      </div>
    </div>
  )
}
