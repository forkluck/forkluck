"use client"

import * as React from "react"
import {
  ArrowUpRight,
  Check,
  Clock,
  SquarePen,
  TrendingUp,
  TriangleAlert,
} from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Chip } from "@/components/ui/chip"
import { DialogFooter } from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { FilterPill } from "@/components/ui/filter-pill"
import {
  Input,
  InputAffix,
  InputGroup,
  SearchInput,
} from "@/components/ui/input"
import { LabeledInput } from "@/components/ui/labeled-field"
import { LoadingRegion } from "@/components/ui/loading-region"
import { MeasureField } from "@/components/ui/measure-field"
import { MetricCard } from "@/components/ui/metric-card"
import { NoticeBanner, NoticeBannerAction } from "@/components/ui/notice-banner"
import { NumberField } from "@/components/ui/number-field"
import {
  Page,
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
  Toolbar,
  ToolbarSpacer,
} from "@/components/ui/page"
import { SaveBanner } from "@/components/ui/save-banner"
import { Spinner } from "@/components/ui/spinner"
import { TableBusy } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Thumbnail } from "@/components/ui/thumbnail"
import { Toggle } from "@/components/ui/toggle"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { Labeled, Matrix, Row } from "./matrix"

/**
 * The demos for the first half of the guide, sections 1 to 26.
 *
 * Each one lays the component's whole range out on the bare page the way the
 * Radix Themes playground does: a `Matrix` when there are variants and sizes
 * to cross, a `Row` of `Labeled` items when there is a single axis, and the
 * composed things once, full width, as a real example. Nothing here draws a
 * border, a caption or a background of its own.
 *
 * The whole file is a client module: the demos that press, remove, step or
 * filter hold their own state, and nothing calls a Server Action, a router, a
 * toast or a date formatter. `sections-a.tsx` stays a server module and
 * imports these components by name.
 */

/** A stand-in photograph, inline so a demo never waits on a request. */
function photo(svg: string) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** An invoice scan: a white sheet, a supplier line, item lines and a total. */
const INVOICE_SCAN = photo(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#e4e4e7"/><rect x="14" y="6" width="68" height="90" fill="#ffffff"/><rect x="22" y="14" width="30" height="5" rx="1" fill="#18181b"/><rect x="22" y="24" width="52" height="2.5" rx="1" fill="#c9c9cf"/><rect x="22" y="32" width="52" height="2.5" rx="1" fill="#c9c9cf"/><rect x="22" y="40" width="52" height="2.5" rx="1" fill="#c9c9cf"/><rect x="22" y="48" width="52" height="2.5" rx="1" fill="#c9c9cf"/><rect x="22" y="56" width="52" height="2.5" rx="1" fill="#c9c9cf"/><rect x="22" y="70" width="52" height="1" fill="#18181b"/><rect x="22" y="76" width="18" height="4" rx="1" fill="#18181b"/><rect x="56" y="76" width="18" height="4" rx="1" fill="#18181b"/></svg>'
)

const CHEF_PHOTO = photo(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#d8e4f7"/><circle cx="32" cy="24" r="12" fill="#3273dc"/><path d="M8 64c2-14 12-22 24-22s22 8 24 22z" fill="#3273dc"/></svg>'
)

/** The top of the same scan, wide: header, supplier line and item lines. */
const INVOICE_SCAN_WIDE = photo(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><rect width="300" height="100" fill="#e4e4e7"/><rect x="60" y="10" width="180" height="120" fill="#ffffff"/><rect x="76" y="24" width="52" height="8" rx="1.5" fill="#18181b"/><rect x="180" y="24" width="44" height="4" rx="1" fill="#c9c9cf"/><rect x="180" y="32" width="44" height="4" rx="1" fill="#c9c9cf"/><rect x="76" y="48" width="148" height="1" fill="#18181b"/><rect x="76" y="58" width="90" height="4" rx="1" fill="#c9c9cf"/><rect x="196" y="58" width="28" height="4" rx="1" fill="#c9c9cf"/><rect x="76" y="70" width="104" height="4" rx="1" fill="#c9c9cf"/><rect x="196" y="70" width="28" height="4" rx="1" fill="#c9c9cf"/><rect x="76" y="82" width="82" height="4" rx="1" fill="#c9c9cf"/><rect x="196" y="82" width="28" height="4" rx="1" fill="#c9c9cf"/><rect x="76" y="94" width="112" height="4" rx="1" fill="#c9c9cf"/><rect x="196" y="94" width="28" height="4" rx="1" fill="#c9c9cf"/></svg>'
)

/** 1. Page */
export function PageDemo() {
  const [status, setStatus] = React.useState("active")
  return (
    <Page
      role="region"
      aria-label="Page example"
      className="px-0 pb-0 sm:px-0 md:px-0 md:pb-0"
    >
      <PageHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            <PageParent href="#page">Recipes</PageParent>
          </PageParents>
          <PageTitle as="h3">Butter croissant</PageTitle>
        </div>
      </PageHeader>
      <Toolbar>
        <SearchInput defaultValue="" />
        <FilterPill
          label="Status"
          value={status}
          options={[
            { value: "active", label: "Active" },
            { value: "draft", label: "Draft" },
            { value: "archived", label: "Archived" },
          ]}
          onSelect={setStatus}
        />
        <ToolbarSpacer />
        <Button variant="outline">Duplicate</Button>
        <Button>Save recipe</Button>
      </Toolbar>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Components</CardTitle>
            <CardDescription>Eight ingredients, one sub recipe</CardDescription>
          </CardHeader>
          <CardContent>
            <p>Flour, butter, milk, yeast, salt, sugar, egg wash, detrempe.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Yield</CardTitle>
            <CardDescription>Per batch</CardDescription>
          </CardHeader>
          <CardContent>
            <p>48 pieces at 82 g, baked from a 24 hour cold ferment.</p>
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}

/** 2. Section */
export function SectionDemo() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Costing</CardTitle>
          <CardDescription>Priced from the last delivery</CardDescription>
        </CardHeader>
        <CardContent>
          <p>
            Butter at $7.40 per kg carries 61% of the batch cost. The sheet
            yields 48 croissants at $0.79 each.
          </p>
        </CardContent>
      </Card>
      <MetricCard
        label="Food cost"
        value="28.4%"
        note="Target 30% or under"
        badge={<Badge variant="success">On target</Badge>}
      />
    </div>
  )
}

/** 3. Heading */
export function HeadingDemo() {
  return (
    <Row>
      <Labeled label="2xl, page title">
        <span className="text-2xl font-semibold tracking-[-0.02em]">
          Butter croissant
        </span>
      </Labeled>
      <Labeled label="xl, dialog title">
        <span className="text-xl font-semibold tracking-[-0.01em]">
          Delete this recipe?
        </span>
      </Labeled>
      <Labeled label="lg, card heading">
        <span className="text-lg font-semibold">Costing</span>
      </Labeled>
      <Labeled label="md, list title">
        <span className="text-md font-semibold">Dry goods</span>
      </Labeled>
    </Row>
  )
}

/** 4. Text */
export function TextDemo() {
  return (
    <Row>
      <Labeled label="Foreground">
        <span className="text-base text-foreground">12 cases of butter</span>
      </Labeled>
      <Labeled label="Muted">
        <span className="text-base text-muted-foreground">
          Priced from the invoice
        </span>
      </Labeled>
      <Labeled label="Faint">
        <span className="text-base text-faint">No photo on file</span>
      </Labeled>
      <Labeled label="Success">
        <span className="text-base text-success">Cost fell 3.1%</span>
      </Labeled>
      <Labeled label="Destructive">
        <span className="text-base text-destructive">Two have no price</span>
      </Labeled>
      <Labeled label="Warning">
        <span className="text-base text-warning-foreground">
          Four lines unmatched
        </span>
      </Labeled>
      <Labeled label="2xs meta">
        <span className="text-2xs text-faint">Updated by the kitchen</span>
      </Labeled>
    </Row>
  )
}

/** 5. Paragraph */
export function ParagraphDemo() {
  return (
    <Row className="items-start">
      <Labeled label="Body, 13.5px over 1.65" className="max-w-[46ch]">
        <p className="text-base leading-[1.65] text-muted-foreground">
          A recipe holds its components, its yield and the method the kitchen
          follows. Costing reads the last price paid for each ingredient, so a
          delivery that moved the price of butter moves the plate cost of every
          recipe that uses it.
        </p>
      </Labeled>
      <Labeled label="Help, 12.5px over 1.55" className="max-w-[46ch]">
        <p className="text-xs leading-[1.55] text-muted-foreground">
          Prices come from the most recent invoice line matched to the
          ingredient.
        </p>
      </Labeled>
    </Row>
  )
}

/** 6. Link */
export function LinkDemo() {
  return (
    <Row>
      <Labeled label="Parent link">
        <PageParent href="#link">Ingredients</PageParent>
      </Labeled>
      <Labeled label="Link button">
        <Button variant="link" nativeButton={false} render={<a href="#link" />}>
          View the invoice
        </Button>
      </Labeled>
      <Labeled label="Link badge">
        <Badge variant="link" render={<a href="#link" />}>
          Baldor
          <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
        </Badge>
      </Labeled>
    </Row>
  )
}

/** 7. Unordered list */
export function UnorderedListDemo() {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-base text-muted-foreground">
      <li>Laminate the dough in three single folds</li>
      <li>Rest 30 minutes between folds</li>
      <li>Proof at 26 C until doubled</li>
    </ul>
  )
}

/** 8. Ordered list */
export function OrderedListDemo() {
  return (
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-base text-muted-foreground">
      <li>Weigh the detrempe and the butter block</li>
      <li>Lock the butter in and chill for an hour</li>
      <li>Roll, cut and shape 48 pieces</li>
    </ol>
  )
}

const BUTTON_VARIANTS = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "quiet",
  "filter",
  "destructive",
  "link",
] as const

const BUTTON_SIZES = ["xs", "sm", "default", "lg"] as const

const BUTTON_LABELS: Record<(typeof BUTTON_VARIANTS)[number], string> = {
  default: "Save recipe",
  outline: "Duplicate",
  secondary: "Actions",
  ghost: "Cancel",
  quiet: "Reset",
  filter: "Status",
  destructive: "Delete",
  link: "Open invoice",
}

const ICON_BUTTON_SIZES = ["icon-xs", "icon-sm", "icon", "icon-lg"] as const

/** 9. Button */
export function ButtonDemo() {
  return (
    <div className="flex flex-col gap-8">
      <Matrix
        columns={BUTTON_VARIANTS}
        rows={BUTTON_SIZES}
        cell={(variant, size) => (
          <Button variant={variant} size={size}>
            {BUTTON_LABELS[variant]}
            {variant === "filter" ? (
              <span className="font-medium text-foreground">Active</span>
            ) : null}
          </Button>
        )}
      />
      <Matrix
        columns={ICON_BUTTON_SIZES}
        rows={["ghost", "outline", "secondary", "default"] as const}
        cell={(size, variant) => (
          <Button
            variant={variant}
            size={size}
            aria-label={`Edit the recipe, ${variant} ${size}`}
          >
            <SquarePen aria-hidden="true" />
          </Button>
        )}
      />
      <Row>
        <Labeled label="Pending">
          <Button pending>Saving</Button>
        </Labeled>
        <Labeled label="Pending, outline">
          <Button variant="outline" pending>
            Recosting
          </Button>
        </Labeled>
        <Labeled label="Disabled">
          <Button disabled>Save recipe</Button>
        </Labeled>
        <Labeled label="Disabled, outline">
          <Button variant="outline" disabled>
            Duplicate
          </Button>
        </Labeled>
        <Labeled label="Disabled, ghost">
          <Button variant="ghost" disabled>
            Cancel
          </Button>
        </Labeled>
      </Row>
    </div>
  )
}

/** 10. Button group */
export function ButtonGroupDemo() {
  return (
    <div className="flex flex-col gap-6">
      <Labeled label="Dialog footer" className="w-full">
        <DialogFooter className="w-full">
          <Button variant="outline">Cancel</Button>
          <Button>Save recipe</Button>
        </DialogFooter>
      </Labeled>
      <Labeled label="Toolbar cluster" className="w-full">
        <Toolbar className="mb-0 w-full">
          <SearchInput defaultValue="" />
          <ToolbarSpacer />
          <Button variant="outline">Export</Button>
          <Button>New recipe</Button>
        </Toolbar>
      </Labeled>
    </div>
  )
}

/** 11. Press button */
export function PressButtonDemo() {
  const [grams, setGrams] = React.useState(true)
  return (
    <div className="flex flex-col gap-8">
      <Matrix
        columns={["default", "icon"] as const}
        rows={["off", "on", "disabled"] as const}
        cell={(size, state) =>
          size === "icon" ? (
            <Toggle
              size="icon"
              aria-label={`Weigh in grams, ${state}`}
              defaultPressed={state === "on"}
              disabled={state === "disabled"}
            >
              <TrendingUp aria-hidden="true" />
            </Toggle>
          ) : (
            <Toggle
              defaultPressed={state === "on"}
              disabled={state === "disabled"}
            >
              Show costs
            </Toggle>
          )
        }
      />
      <Row>
        <Labeled label="Holds its own state">
          <Toggle pressed={grams} onPressedChange={setGrams}>
            Weigh in grams
          </Toggle>
        </Labeled>
      </Row>
    </div>
  )
}

/** 12. Clickable */
export function ClickableDemo() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Labeled label="Whole card is the link" className="w-full">
        <Card render={<a href="#clickable" />} className="w-full">
          <CardHeader>
            <CardTitle>Butter croissant</CardTitle>
            <CardDescription>48 pieces per batch</CardDescription>
          </CardHeader>
          <CardContent>
            <p>Flour, butter, milk, yeast, salt, sugar.</p>
          </CardContent>
        </Card>
      </Labeled>
      <Labeled label="Same shell, no destination" className="w-full">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Pain au chocolat</CardTitle>
            <CardDescription>36 pieces per batch</CardDescription>
          </CardHeader>
          <CardContent>
            <p>Flour, butter, milk, yeast, salt, batons.</p>
          </CardContent>
        </Card>
      </Labeled>
    </div>
  )
}

const BADGE_VARIANTS = [
  "default",
  "secondary",
  "success",
  "warning",
  "destructive",
  "outline",
  "ghost",
  "link",
] as const

const BADGE_LABELS: Record<(typeof BADGE_VARIANTS)[number], string> = {
  default: "Package",
  secondary: "Draft",
  success: "On target",
  warning: "Unmatched",
  destructive: "No price",
  outline: "Sub recipe",
  ghost: "Archived",
  link: "Baldor",
}

/** 13. Badge */
export function BadgeDemo() {
  return (
    <div className="flex flex-col gap-8">
      <Matrix
        columns={BADGE_VARIANTS}
        rows={["default", "row"] as const}
        cell={(variant, size) => (
          <Badge variant={variant} size={size}>
            {BADGE_LABELS[variant]}
          </Badge>
        )}
      />
      <Row>
        <Labeled label="Leading icon">
          <Badge variant="success">
            <TrendingUp data-icon="inline-start" aria-hidden="true" />
            4.2%
          </Badge>
        </Labeled>
        <Labeled label="Trailing icon">
          <Badge variant="link" render={<a href="#badge" />}>
            Baldor
            <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
          </Badge>
        </Labeled>
        <Labeled label="Row size, leading icon">
          <Badge size="row" variant="warning">
            <TriangleAlert data-icon="inline-start" aria-hidden="true" />
            Over target
          </Badge>
        </Labeled>
      </Row>
    </div>
  )
}

/** 14. Banner */
export function BannerDemo() {
  return (
    <div className="flex flex-col gap-4">
      <NoticeBanner
        className="mb-0"
        action={<NoticeBannerAction>Review</NoticeBannerAction>}
      >
        Four invoice lines are not matched to an ingredient.
      </NoticeBanner>
      <SaveBanner text="Butter is priced in two units. Which one should costing use?">
        <Button variant="outline">Keep kilograms</Button>
        <Button>Use cases</Button>
      </SaveBanner>
    </div>
  )
}

/** 15. Chip */
export function ChipDemo() {
  const [amount, setAmount] = React.useState("250")
  const [unit, setUnit] = React.useState<string | null>("gram")
  return (
    <div className="flex flex-col gap-8">
      <Row>
        <Labeled label="Chip">
          <Chip>Allergen free</Chip>
        </Labeled>
        <Labeled label="Chip, pressed">
          <Chip pressed>Milk</Chip>
        </Labeled>
        <Labeled label="Badge, row size">
          <Badge size="row">Case</Badge>
        </Labeled>
        <Labeled label="Badge, row outline">
          <Badge size="row" variant="outline">
            Sub recipe
          </Badge>
        </Labeled>
      </Row>
      <div className="max-w-[220px]">
        <MeasureField
          label="Butter"
          amount={amount}
          unit={unit}
          options={[
            { slug: "gram", label: "Grams (g)" },
            { slug: "kilogram", label: "Kilograms (kg)" },
          ]}
          onAmountChange={setAmount}
          onUnitChange={setUnit}
        />
      </div>
    </div>
  )
}

/** 16. Clickable chip */
export function ClickableChipDemo() {
  const [pressed, setPressed] = React.useState<string[]>(["Milk"])
  const [tags, setTags] = React.useState(["Baldor", "Dry goods"])
  const allergens = ["Milk", "Eggs", "Wheat"]
  return (
    <Row className="items-start">
      <Labeled label="Pressable">
        <div className="flex flex-wrap items-center gap-2">
          {allergens.map((allergen) => (
            <Chip
              key={allergen}
              pressed={pressed.includes(allergen)}
              onPressedChange={(next) =>
                setPressed((current) =>
                  next
                    ? [...current, allergen]
                    : current.filter((name) => name !== allergen)
                )
              }
            >
              {allergen}
            </Chip>
          ))}
        </div>
      </Labeled>
      <Labeled label="Removable">
        <div className="flex flex-wrap items-center gap-2">
          {tags.map((tag) => (
            <Chip
              key={tag}
              removeLabel={`Remove ${tag}`}
              onRemove={() =>
                setTags((current) => current.filter((name) => name !== tag))
              }
            >
              {tag}
            </Chip>
          ))}
          {tags.length === 0 ? (
            <span className="text-xs text-faint">Every tag removed</span>
          ) : null}
        </div>
      </Labeled>
    </Row>
  )
}

/** 17. Spinner */
export function SpinnerDemo() {
  return (
    <div className="flex flex-col gap-8">
      <Row>
        <Labeled label="sm, 16px">
          <Spinner size="sm" />
        </Labeled>
        <Labeled label="md, 32px">
          <Spinner size="md" />
        </Labeled>
        <Labeled label="lg, 80px">
          <Spinner size="lg" />
        </Labeled>
        <Labeled label="On the control pressed">
          <Button pending>Saving</Button>
        </Labeled>
      </Row>
      <LoadingRegion pending label="Loading recipes" className="min-h-40">
        <p className="text-base text-muted-foreground">
          48 recipes, costed on Monday. The numbers stay legible while the
          screen waits.
        </p>
      </LoadingRegion>
      <div className="relative h-32 rounded-xl border border-border bg-card">
        <p className="p-4 text-base text-muted-foreground">
          Butter croissant, Pain au chocolat, Kouign amann
        </p>
        <TableBusy />
      </div>
    </div>
  )
}

/** 18. Tooltip */
export function TooltipDemo() {
  return (
    <Row>
      <Labeled label="On an icon button">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon" aria-label="Price history">
                <Clock aria-hidden="true" />
              </Button>
            }
          />
          <TooltipContent>Price history</TooltipContent>
        </Tooltip>
      </Labeled>
      <Labeled label="On a text button">
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline">Recost</Button>} />
          <TooltipContent>
            Reprice every recipe from the last invoice
          </TooltipContent>
        </Tooltip>
      </Labeled>
    </Row>
  )
}

/** 19. Avatar */
export function AvatarDemo() {
  return (
    <Matrix
      columns={["initials", "photo"] as const}
      rows={["sm", "default", "lg"] as const}
      cell={(kind, size) =>
        kind === "photo" ? (
          <Avatar size={size}>
            <AvatarImage src={CHEF_PHOTO} alt="Head chef" />
            <AvatarFallback>HC</AvatarFallback>
          </Avatar>
        ) : (
          <Avatar size={size}>
            <AvatarFallback>HC</AvatarFallback>
          </Avatar>
        )
      }
    />
  )
}

/** 20. Thumbnail */
export function ThumbnailDemo() {
  return (
    <Matrix
      columns={["scan", "no file"] as const}
      rows={["sm", "default", "lg"] as const}
      cell={(kind, size) =>
        kind === "scan" ? (
          <Thumbnail
            size={size}
            src={INVOICE_SCAN}
            alt="Baldor invoice, scanned"
          />
        ) : (
          <Thumbnail size={size} alt="No scan on file" />
        )
      }
    />
  )
}

/** 21. Image */
export function ImageDemo() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={INVOICE_SCAN_WIDE}
      alt="Baldor invoice, page 1, scanned"
      className="aspect-3/1 w-full rounded-lg border border-border object-cover"
    />
  )
}

/** 22. Icon */
export function IconDemo() {
  return (
    <div className="flex flex-col gap-8">
      <Row>
        <Labeled label="14px, in a button">
          <SquarePen className="size-3.5 text-foreground" aria-hidden="true" />
        </Labeled>
        <Labeled label="15px, check slot">
          <Check className="size-[15px] text-foreground" aria-hidden="true" />
        </Labeled>
        <Labeled label="17px, menu row">
          <Clock className="size-[17px] text-foreground" aria-hidden="true" />
        </Labeled>
      </Row>
      <Row>
        <Labeled label="Foreground">
          <SquarePen
            className="size-[17px] text-foreground"
            aria-hidden="true"
          />
        </Labeled>
        <Labeled label="Muted">
          <SquarePen
            className="size-[17px] text-muted-foreground"
            aria-hidden="true"
          />
        </Labeled>
        <Labeled label="Success">
          <Check className="size-[17px] text-success" aria-hidden="true" />
        </Labeled>
        <Labeled label="Destructive">
          <TriangleAlert
            className="size-[17px] text-destructive"
            aria-hidden="true"
          />
        </Labeled>
        <Labeled label="Warning">
          <TriangleAlert
            className="size-[17px] text-warning"
            aria-hidden="true"
          />
        </Labeled>
        <Labeled label="Brand">
          <TrendingUp className="size-[17px] text-primary" aria-hidden="true" />
        </Labeled>
      </Row>
    </div>
  )
}

/** 23. Text field */
export function TextFieldDemo() {
  return (
    <Row className="items-start">
      <Labeled label="Empty" className="w-[220px]">
        <LabeledInput
          label="Recipe name"
          placeholder="Butter croissant"
          containerClassName="w-full"
        />
      </Labeled>
      <Labeled label="Filled" className="w-[220px]">
        <LabeledInput
          label="Supplier"
          defaultValue="Baldor"
          containerClassName="w-full"
        />
      </Labeled>
      <Labeled label="With help text" className="w-[220px]">
        <Field className="w-full">
          <FieldLabel htmlFor="guide-station">Station</FieldLabel>
          <Input id="guide-station" defaultValue="Pastry" />
          <FieldDescription>Printed on the prep sheet.</FieldDescription>
        </Field>
      </Labeled>
      <Labeled label="Error" className="w-[220px]">
        <Field data-invalid="true" className="w-full">
          <FieldLabel htmlFor="guide-yield">Yield</FieldLabel>
          <Input id="guide-yield" aria-invalid defaultValue="0" />
          <FieldError>Yield has to be greater than zero.</FieldError>
        </Field>
      </Labeled>
      <Labeled label="Disabled" className="w-[220px]">
        <LabeledInput
          label="Batch code"
          defaultValue="BC-2026-09"
          disabled
          containerClassName="w-full"
        />
      </Labeled>
    </Row>
  )
}

/** 24. Text area */
export function TextAreaDemo() {
  return (
    <Row className="items-start">
      <Labeled label="Empty" className="w-[280px]">
        <Textarea
          aria-label="Method, empty"
          placeholder="Write the method the way the kitchen reads it"
        />
      </Labeled>
      <Labeled label="Filled" className="w-[280px]">
        <Field className="w-full">
          <FieldLabel htmlFor="guide-method">Method</FieldLabel>
          <Textarea
            id="guide-method"
            defaultValue={
              "Laminate in three single folds, resting 30 minutes between them. Proof at 26 C until doubled, then egg wash and bake at 190 C for 18 minutes."
            }
          />
          <FieldDescription>
            The method prints with the recipe.
          </FieldDescription>
        </Field>
      </Labeled>
      <Labeled label="Error" className="w-[280px]">
        <Field data-invalid="true" className="w-full">
          <FieldLabel htmlFor="guide-notes">Prep notes</FieldLabel>
          <Textarea id="guide-notes" aria-invalid defaultValue="" />
          <FieldError>Prep notes cannot be empty.</FieldError>
        </Field>
      </Labeled>
      <Labeled label="Disabled" className="w-[280px]">
        <Textarea
          aria-label="Method, locked"
          disabled
          defaultValue="Locked while the recipe is costing."
        />
      </Labeled>
    </Row>
  )
}

/** 25. Number field */
export function NumberFieldDemo() {
  const [batches, setBatches] = React.useState<number | null>(2)
  const [days, setDays] = React.useState<number | null>(1)
  return (
    <Row className="items-start">
      <Labeled label="Default" className="w-[200px]">
        <NumberField
          label="Batches"
          value={batches}
          onValueChange={(next) => setBatches(next)}
          min={1}
          max={12}
          step={1}
        />
      </Labeled>
      <Labeled label="At the minimum" className="w-[200px]">
        <NumberField
          label="Days of cover"
          value={days}
          onValueChange={(next) => setDays(next)}
          min={1}
          max={30}
          step={1}
        />
      </Labeled>
      <Labeled label="Disabled" className="w-[200px]">
        <NumberField label="Yield" value={48} disabled min={1} step={1} />
      </Labeled>
    </Row>
  )
}

/** 26. Money field */
export function MoneyFieldDemo() {
  return (
    <Row className="items-start">
      <Labeled label="Prefix" className="w-[200px]">
        <div className="flex w-full flex-col gap-2">
          <FieldLabel htmlFor="guide-price">Case price</FieldLabel>
          <InputGroup>
            <InputAffix>$</InputAffix>
            <Input
              id="guide-price"
              className="pl-[26px]"
              defaultValue="74.00"
            />
          </InputGroup>
        </div>
      </Labeled>
      <Labeled label="Prefix and suffix" className="w-[200px]">
        <div className="flex w-full flex-col gap-2">
          <FieldLabel htmlFor="guide-rate">Pastry rate</FieldLabel>
          <InputGroup>
            <InputAffix>$</InputAffix>
            <Input
              id="guide-rate"
              className="pr-16 pl-[26px]"
              defaultValue="21.50"
            />
            <InputAffix side="end">/ hour</InputAffix>
          </InputGroup>
        </div>
      </Labeled>
      <Labeled label="Empty" className="w-[200px]">
        <div className="flex w-full flex-col gap-2">
          <FieldLabel htmlFor="guide-margin">Target margin</FieldLabel>
          <InputGroup>
            <InputAffix>$</InputAffix>
            <Input id="guide-margin" className="pl-[26px]" placeholder="0.00" />
          </InputGroup>
        </div>
      </Labeled>
      <Labeled label="Disabled" className="w-[200px]">
        <div className="flex w-full flex-col gap-2">
          <FieldLabel htmlFor="guide-landed">Landed cost</FieldLabel>
          <InputGroup>
            <InputAffix>$</InputAffix>
            <Input
              id="guide-landed"
              className="pl-[26px]"
              defaultValue="7.40"
              disabled
            />
          </InputGroup>
        </div>
      </Labeled>
    </Row>
  )
}
