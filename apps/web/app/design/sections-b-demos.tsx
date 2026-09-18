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
import { LabeledInput } from "@/components/ui/labeled-field"
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

import { Labeled, Matrix, Row } from "./matrix"

/**
 * Every demo body for sections 27 to 51 of the visual guide: the app's own
 * components laid out the way the Radix Themes playground lays its own out,
 * on kitchen data and on the bare white page.
 *
 * A component with two axes gets a `Matrix`, variants across and sizes or
 * states down; a component with one axis gets a `Row` of `Labeled` things; a
 * composed thing renders once as a real example. Nothing else is drawn: no
 * borders, no fills and no captions around a demo.
 *
 * This is the client half of the registry. The list itself lives in
 * `sections-b.tsx`, which stays a server module so the page can read it: in
 * RSC every export of a "use client" module becomes a client reference, and a
 * server component mapping over an array imported from one would throw.
 *
 * Nothing here talks to the server, the router or the clock. A demo that needs
 * state keeps it in this file, and the date field is pinned to UTC on a fixed
 * day so the page renders the same thing every time.
 */

/** The vertical rhythm of a demo that stacks more than one thing. */
const STACK = "flex flex-col gap-6"

/** The states every text field is shown in, in one order. */
const FIELD_STATES = ["Empty", "Filled", "Error", "Disabled"] as const

export function EmailFieldDemo() {
  return (
    <Row>
      <Labeled label="Empty" className="w-64">
        <LabeledInput
          label="Billing email"
          type="email"
          placeholder="invoices@yourkitchen.com"
          autoComplete="off"
          containerClassName="w-full"
        />
      </Labeled>
      <Labeled label="Filled" className="w-64">
        <LabeledInput
          label="Billing email"
          type="email"
          defaultValue="orders@ternbakery.com"
          autoComplete="off"
          containerClassName="w-full"
        />
      </Labeled>
      <Labeled label="Error" className="w-64">
        <LabeledInput
          label="Billing email"
          type="email"
          defaultValue="orders@ternbakery"
          aria-invalid
          autoComplete="off"
          containerClassName="w-full"
        />
      </Labeled>
      <Labeled label="Disabled" className="w-64">
        <LabeledInput
          label="Billing email"
          type="email"
          defaultValue="orders@ternbakery.com"
          disabled
          autoComplete="off"
          containerClassName="w-full"
        />
      </Labeled>
    </Row>
  )
}

export function PasswordFieldDemo() {
  return (
    <Row>
      {FIELD_STATES.map((state) => (
        <Labeled key={state} label={state.toLowerCase()} className="w-64">
          <LabeledInput
            label="Password"
            type="password"
            defaultValue={state === "Empty" ? undefined : "sourdough-starter"}
            placeholder={
              state === "Empty" ? "At least 10 characters" : undefined
            }
            aria-invalid={state === "Error" || undefined}
            disabled={state === "Disabled"}
            autoComplete="off"
            containerClassName="w-full"
          />
        </Labeled>
      ))}
    </Row>
  )
}

export function UrlFieldDemo() {
  return (
    <Row>
      {FIELD_STATES.map((state) => (
        <Labeled key={state} label={state.toLowerCase()} className="w-64">
          <InputGroup className="w-full">
            <InputAffix>https://</InputAffix>
            <Input
              type="url"
              aria-label="Supplier portal"
              defaultValue={state === "Empty" ? undefined : "baldor.com/orders"}
              placeholder={state === "Empty" ? "yoursupplier.com" : undefined}
              aria-invalid={state === "Error" || undefined}
              disabled={state === "Disabled"}
              autoComplete="off"
              spellCheck={false}
              className="pl-[62px]"
            />
          </InputGroup>
        </Labeled>
      ))}
    </Row>
  )
}

export function SearchFieldDemo() {
  return (
    <Row>
      <Labeled label="Empty">
        <SearchInput label="Search ingredients" />
      </Labeled>
      <Labeled label="Filled">
        <SearchInput label="Search recipes" defaultValue="croissant" />
      </Labeled>
      <Labeled label="Disabled">
        <SearchInput label="Search invoices" defaultValue="Baldor" disabled />
      </Labeled>
    </Row>
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

const SELECT_STATES = ["Value", "Placeholder", "Error", "Disabled"] as const
const SELECT_SIZES = ["sm", "default"] as const

export function SelectDemo() {
  return (
    <div className={STACK}>
      <Matrix
        columns={SELECT_STATES}
        rows={SELECT_SIZES}
        cell={(state, size) => (
          <Select
            defaultValue={state === "Placeholder" ? undefined : "Kilogram"}
          >
            <SelectTrigger
              size={size}
              aria-label="Purchase unit"
              aria-invalid={state === "Error" || undefined}
              disabled={state === "Disabled"}
              className="w-40"
            >
              <SelectValue placeholder="Pick a unit" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Kilogram">Kilogram</SelectItem>
              <SelectItem value="Pound">Pound</SelectItem>
              <SelectItem value="Litre">Litre</SelectItem>
            </SelectContent>
          </Select>
        )}
      />
      <Row>
        <Labeled label="Grouped list">
          <Select defaultValue="Kilogram">
            <SelectTrigger aria-label="Purchase unit" className="w-56">
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
        </Labeled>
        <Labeled label="Searchable">
          <UnitComboboxDemo />
        </Labeled>
      </Row>
    </div>
  )
}

export function DateFieldDemo() {
  const [delivery, setDelivery] = React.useState("2026-09-16")
  const [invoiced, setInvoiced] = React.useState("")
  return (
    <Row>
      <Labeled label="Filled" className="w-64">
        <DateField
          id="guide-date-field"
          label="Delivery date"
          value={delivery}
          onChange={setDelivery}
          timeZone="UTC"
          containerClassName="w-full"
        />
      </Labeled>
      <Labeled label="Empty" className="w-64">
        <DateField
          id="guide-date-field-empty"
          label="Invoice date"
          value={invoiced}
          onChange={setInvoiced}
          placeholder="YYYY-MM-DD"
          timeZone="UTC"
          containerClassName="w-full"
        />
      </Labeled>
    </Row>
  )
}

export function DatePickerDemo() {
  const [day, setDay] = React.useState("2026-09-16")
  const [range, setRange] = React.useState<{
    startDate: string | null
    endDate: string | null
  }>({ startDate: "2026-09-01", endDate: "2026-09-16" })

  return (
    <div className={STACK}>
      <div className="w-[19rem]">
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
  const [chart, setChart] = React.useState("#3273dc")
  const [tag, setTag] = React.useState("#2f7a4f")
  return (
    <Row>
      <Labeled label="Chart series" className="w-64">
        <ColorField
          label="Chart color"
          value={chart}
          onValueChange={setChart}
          className="w-full"
        />
      </Labeled>
      <Labeled label="Station tag" className="w-64">
        <ColorField
          label="Station color"
          value={tag}
          onValueChange={setTag}
          className="w-full"
        />
      </Labeled>
    </Row>
  )
}

export function ColorPickerDemo() {
  const [color, setColor] = React.useState("#2f7a4f")
  return <ColorPicker value={color} onValueChange={setColor} />
}

export function DropZoneDemo() {
  const [names, setNames] = React.useState<string[]>([])
  return (
    <Row>
      <Labeled label="Ready" className="w-80">
        <DropZone
          accept="application/pdf"
          multiple
          onFiles={(files) => setNames(files.map((file) => file.name))}
          className="w-full"
        >
          {names.length > 0
            ? names.join(", ")
            : "PDF invoices, up to 5 MB each"}
        </DropZone>
      </Labeled>
      <Labeled label="Disabled" className="w-80">
        <DropZone
          accept="application/pdf"
          disabled
          onFiles={() => undefined}
          className="w-full"
        >
          PDF invoices, up to 5 MB each
        </DropZone>
      </Labeled>
    </Row>
  )
}

const CHECKBOX_STATES = [
  "Unchecked",
  "Checked",
  "Indeterminate",
  "Error",
] as const
const ENABLEMENT = ["Enabled", "Disabled"] as const

export function CheckboxDemo() {
  return (
    <Matrix
      columns={ENABLEMENT}
      rows={CHECKBOX_STATES}
      cell={(enablement, state) => (
        <Checkbox
          aria-label={`Bread flour, ${state.toLowerCase()}, ${enablement.toLowerCase()}`}
          defaultChecked={state === "Checked"}
          indeterminate={state === "Indeterminate"}
          aria-invalid={state === "Error" || undefined}
          disabled={enablement === "Disabled"}
        />
      )}
    />
  )
}

const RADIO_STATES = ["Unchecked", "Checked"] as const

export function ChoiceListDemo() {
  const [basis, setBasis] = React.useState("yield")
  return (
    <div className={STACK}>
      <Matrix
        columns={ENABLEMENT}
        rows={RADIO_STATES}
        cell={(enablement, state) => (
          <RadioGroup
            aria-label={`Costing basis, ${state.toLowerCase()}, ${enablement.toLowerCase()}`}
            defaultValue={state === "Checked" ? "on" : "off"}
          >
            <RadioItem
              value="on"
              aria-label="Yield cost"
              disabled={enablement === "Disabled"}
            />
          </RadioGroup>
        )}
      />
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
    </div>
  )
}

const SWITCH_SIZES = ["sm", "default"] as const
const SWITCH_STATES = ["Off", "On", "Disabled"] as const

export function SwitchDemo() {
  return (
    <div className={STACK}>
      <Matrix
        columns={SWITCH_SIZES}
        rows={SWITCH_STATES}
        cell={(size, state) => (
          <Switch
            size={size}
            aria-label={`Show costs, ${size}, ${state.toLowerCase()}`}
            defaultChecked={state === "On"}
            disabled={state === "Disabled"}
          />
        )}
      />
      <Field orientation="horizontal">
        <Switch id="guide-switch-costs" defaultChecked />
        <FieldLabel htmlFor="guide-switch-costs">
          Show costs on the recipe
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
  )
}

export function DividerDemo() {
  return (
    <Row>
      <Labeled label="Horizontal" className="w-64">
        <div className="flex w-full flex-col gap-3">
          <p className="text-md">Yield 24 croissants</p>
          <Separator />
          <p className="text-md">Batch time 3 h 20 m</p>
        </div>
      </Labeled>
      <Labeled label="Vertical">
        <div className="flex h-5 items-center gap-3 text-md">
          <span>Bakery</span>
          <Separator orientation="vertical" />
          <span>Pastry</span>
          <Separator orientation="vertical" />
          <span>Larder</span>
        </div>
      </Labeled>
      <Labeled label="With a word" className="w-64">
        <div className="w-full py-2">
          <FieldSeparator>or</FieldSeparator>
        </div>
      </Labeled>
    </Row>
  )
}

export function BoxDemo() {
  return (
    <Row>
      <Labeled label="Card" className="w-72">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Butter croissant</CardTitle>
            <CardDescription>Updated this morning</CardDescription>
          </CardHeader>
          <CardContent>Twelve components, costed from last week.</CardContent>
        </Card>
      </Labeled>
      <Labeled label="Tighter padding" className="w-72">
        <Card className="w-full gap-2 p-3">
          <CardTitle>Pain au chocolat</CardTitle>
          <CardContent>Nine components, costed this morning.</CardContent>
        </Card>
      </Labeled>
      <Labeled label="Soft panel" className="w-72">
        <div className="w-full rounded-lg bg-fill-soft px-4 py-3 text-md">
          Yield 24 croissants at $1.14 each
        </div>
      </Labeled>
      <Labeled label="Grey panel" className="w-72">
        <div className="w-full rounded-lg bg-secondary px-4 py-3 text-md">
          Yield 24 croissants at $1.14 each
        </div>
      </Labeled>
    </Row>
  )
}

export function StackDemo() {
  return (
    <Row>
      <Labeled label="gap-2">
        <div className="flex flex-col gap-2">
          <p className="text-md">Bread flour</p>
          <p className="text-md">European butter</p>
          <p className="text-md">Sea salt</p>
        </div>
      </Labeled>
      <Labeled label="gap-4">
        <div className="flex flex-col gap-4">
          <p className="text-md">Mix and rest</p>
          <p className="text-md">Laminate</p>
          <p className="text-md">Proof and bake</p>
        </div>
      </Labeled>
      <Labeled label="Action row">
        <div className="flex items-center gap-2">
          <Button variant="outline">Cancel</Button>
          <Button>Save recipe</Button>
        </div>
      </Labeled>
    </Row>
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
          Bread flour, European butter, sea salt, fresh yeast, whole milk.
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Costing</CardTitle>
          <CardDescription>Yield basis</CardDescription>
        </CardHeader>
        <CardContent>$1.14 per croissant, 68% margin.</CardContent>
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
          <p key={supplier} className="text-md">
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
          <p className="text-xs font-medium text-muted-foreground">
            Visible columns
          </p>
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
    <Row>
      <Labeled label="Command rows">
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
      </Labeled>
      <Labeled label="Check rows">
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
      </Labeled>
      <Labeled label="Row actions">
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
      </Labeled>
    </Row>
  )
}

export function ModalDemo() {
  const [confirming, setConfirming] = React.useState(false)
  const [typing, setTyping] = React.useState(false)
  return (
    <Row>
      <Labeled label="Dialog">
        <Dialog>
          <DialogTrigger
            render={<Button variant="outline">Duplicate recipe</Button>}
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
      </Labeled>
      <Labeled label="Confirm">
        <Button variant="destructive" onClick={() => setConfirming(true)}>
          Delete recipe
        </Button>
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Delete Butter croissant?"
          description="Twelve components and every costing on this recipe go with it."
          confirmLabel="Delete recipe"
          onConfirm={() => setConfirming(false)}
        />
      </Labeled>
      <Labeled label="Confirm, type to confirm">
        <Button variant="destructive" onClick={() => setTyping(true)}>
          Delete kitchen
        </Button>
        <ConfirmDialog
          open={typing}
          onOpenChange={setTyping}
          title="Delete Test kitchen?"
          description="Every ingredient, recipe, invoice and sale in this kitchen goes with it."
          confirmLabel="Delete kitchen"
          confirmText="Test kitchen"
          onConfirm={() => setTyping(false)}
        />
      </Labeled>
    </Row>
  )
}

export function EmptyStateDemo() {
  return (
    <div className={STACK}>
      <EmptyState
        titleAs="h3"
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
    <div className={STACK}>
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
      <Row>
        <Labeled label="Hero numeral">
          <p className="text-2xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
            $1.14
          </p>
        </Labeled>
        <Labeled label="Stats">
          <dl className="flex flex-wrap gap-8">
            <Stat label="Components" value="12" />
            <Stat label="Yield" value="24" />
            <Stat label="Batch cost" value="$27.36" />
          </dl>
        </Labeled>
        <Labeled label="Aligned column">
          <div className="flex w-56 flex-col gap-1 text-md tabular-nums">
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
        </Labeled>
      </Row>
    </div>
  )
}
