"use client"

import * as React from "react"
import {
  ArrowUpRight,
  Check,
  Clock,
  Scale,
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

/**
 * The live panes for the first half of the visual guide, sections 1 to 26.
 * Every demo renders the app's own components on the app's own tokens, with
 * kitchen data in them, so the guide shows what ships rather than a drawing of
 * it.
 *
 * The whole file is a client module: the demos that press, remove, step or
 * filter hold their own state, and nothing here calls a Server Action, a
 * router, a toast or a date formatter. `sections-a.tsx` stays a server module
 * and imports these components by name.
 */

/** A stand-in photograph, inline so a pane never waits on a request. */
function photo(svg: string) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const CROISSANT_PHOTO = photo(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#f4ead6"/><path d="M14 62c12-26 56-26 68 0-14 10-54 10-68 0z" fill="#c8880c"/><path d="M30 54c6-10 30-10 36 0-8 5-28 5-36 0z" fill="#eaa93a"/></svg>'
)

const CHEF_PHOTO = photo(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#d8e4f7"/><circle cx="32" cy="24" r="12" fill="#3273dc"/><path d="M8 64c2-14 12-22 24-22s22 8 24 22z" fill="#3273dc"/></svg>'
)

const PREP_PHOTO = photo(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><rect width="300" height="100" fill="#eaf4ee"/><circle cx="70" cy="50" r="28" fill="#2f7a4f"/><rect x="130" y="26" width="140" height="48" rx="10" fill="#c8880c"/></svg>'
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
          <PageTitle role="heading" aria-level={3}>
            Butter croissant
          </PageTitle>
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
  const steps = [
    {
      className: "text-2xl font-semibold tracking-[-0.02em]",
      text: "Butter croissant",
      note: "24px page title",
    },
    {
      className: "text-xl font-semibold tracking-[-0.01em]",
      text: "Delete this recipe?",
      note: "17px dialog title",
    },
    {
      className: "text-lg font-semibold",
      text: "Costing",
      note: "16px card heading",
    },
    {
      className: "text-md font-semibold",
      text: "Dry goods",
      note: "14px list title",
    },
  ]
  return (
    <div className="flex flex-col gap-3">
      {steps.map((step) => (
        <div key={step.note} className="flex flex-wrap items-baseline gap-3">
          <span className={step.className}>{step.text}</span>
          <span className="text-2xs text-faint">{step.note}</span>
        </div>
      ))}
    </div>
  )
}

/** 4. Text */
export function TextDemo() {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-base text-foreground">
        Baldor delivered 12 cases of butter on Monday.
      </p>
      <p className="text-base text-muted-foreground">
        Priced from the invoice, not the catalogue.
      </p>
      <p className="text-base text-faint">No photo on file</p>
      <p className="text-base text-success">Cost fell 3.1% against last week</p>
      <p className="text-base text-destructive">
        Two ingredients have no purchase price
      </p>
      <p className="text-base text-warning-foreground">
        Four invoice lines are still unmatched
      </p>
      <p className="text-2xs text-faint">Updated by the kitchen</p>
    </div>
  )
}

/** 5. Paragraph */
export function ParagraphDemo() {
  return (
    <div className="flex max-w-[60ch] flex-col gap-3">
      <p className="text-base leading-[1.65] text-muted-foreground">
        A recipe holds its components, its yield and the method the kitchen
        follows. Costing reads the last price paid for each ingredient, so a
        delivery that moved the price of butter moves the plate cost of every
        recipe that uses it.
      </p>
      <p className="text-xs leading-[1.55] text-muted-foreground">
        Prices come from the most recent invoice line matched to the ingredient.
      </p>
    </div>
  )
}

/** 6. Link */
export function LinkDemo() {
  return (
    <div className="flex flex-wrap items-center gap-5">
      <PageParent href="#link">Ingredients</PageParent>
      <Button variant="link" nativeButton={false} render={<a href="#link" />}>
        View the invoice
      </Button>
      <Badge variant="link" render={<a href="#link" />}>
        Baldor
        <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
      </Badge>
    </div>
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

/** 9. Button */
export function ButtonDemo() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button>Save recipe</Button>
        <Button variant="outline">Duplicate</Button>
        <Button variant="secondary">Actions</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="quiet">Reset</Button>
        <Button variant="filter">
          Status
          <span className="font-medium text-foreground">Active</span>
        </Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="link">Open invoice</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs">24px</Button>
        <Button size="sm">28px</Button>
        <Button size="default">32px</Button>
        <Button size="lg">36px</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon-xs" aria-label="Edit at 24px">
          <SquarePen aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Edit at 28px">
          <SquarePen aria-hidden="true" />
        </Button>
        <Button variant="outline" size="icon" aria-label="Edit at 32px">
          <SquarePen aria-hidden="true" />
        </Button>
        <Button variant="outline" size="icon-lg" aria-label="Edit at 36px">
          <SquarePen aria-hidden="true" />
        </Button>
        <Button pending>Saving</Button>
        <Button disabled>Unavailable</Button>
      </div>
    </div>
  )
}

/** 10. Button group */
export function ButtonGroupDemo() {
  return (
    <div className="flex flex-col gap-5">
      <DialogFooter>
        <Button variant="outline">Cancel</Button>
        <Button>Save recipe</Button>
      </DialogFooter>
      <Toolbar className="mb-0">
        <SearchInput defaultValue="" />
        <ToolbarSpacer />
        <Button variant="outline">Export</Button>
        <Button>New recipe</Button>
      </Toolbar>
    </div>
  )
}

/** 11. Press button */
export function PressButtonDemo() {
  const [bold, setBold] = React.useState(false)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Toggle>Show waste</Toggle>
      <Toggle defaultPressed>Show costs</Toggle>
      <Toggle
        size="icon"
        aria-label="Weigh in grams"
        pressed={bold}
        onPressedChange={(next) => setBold(next)}
      >
        <Scale aria-hidden="true" />
      </Toggle>
    </div>
  )
}

/** 12. Clickable */
export function ClickableDemo() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card render={<a href="#clickable" />}>
        <CardHeader>
          <CardTitle>Butter croissant</CardTitle>
          <CardDescription>48 pieces per batch</CardDescription>
        </CardHeader>
        <CardContent>
          <p>The whole card is the link. Hover it, then focus it.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Pain au chocolat</CardTitle>
          <CardDescription>Not clickable</CardDescription>
        </CardHeader>
        <CardContent>
          <p>The same shell without a destination.</p>
        </CardContent>
      </Card>
    </div>
  )
}

/** 13. Badge */
export function BadgeDemo() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Package</Badge>
        <Badge variant="secondary">Draft</Badge>
        <Badge variant="success">
          <TrendingUp data-icon="inline-start" aria-hidden="true" />
          4.2%
        </Badge>
        <Badge variant="warning">Unmatched</Badge>
        <Badge variant="destructive">No price</Badge>
        <Badge variant="outline">Sub recipe</Badge>
        <Badge variant="ghost">Archived</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="row">Case</Badge>
        <Badge size="row" variant="success">
          On target
        </Badge>
        <Badge size="row" variant="warning">
          Over target
        </Badge>
        <Badge size="row" className="rounded-sm px-[7px] text-2xs">
          Dry goods
        </Badge>
      </div>
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="row">Case</Badge>
        <Badge size="row" variant="outline">
          Sub recipe
        </Badge>
        <Badge size="row" className="rounded-sm px-[7px] text-2xs">
          Dry goods
        </Badge>
        <Chip>Allergen free</Chip>
      </div>
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
    <div className="flex flex-col gap-4">
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
    </div>
  )
}

/** 17. Spinner */
export function SpinnerDemo() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-6">
        <Spinner size="sm" />
        <Spinner size="md" />
        <Spinner size="lg" />
        <Button pending>Saving</Button>
      </div>
      <LoadingRegion pending label="Loading recipes">
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
    <div className="flex flex-wrap items-center gap-3">
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
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline">Recost</Button>} />
        <TooltipContent>
          Reprice every recipe from the last invoice
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/** 19. Avatar */
export function AvatarDemo() {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Avatar size="sm">
        <AvatarFallback>FL</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>HC</AvatarFallback>
      </Avatar>
      <Avatar size="lg">
        <AvatarFallback>SP</AvatarFallback>
      </Avatar>
      <Avatar size="lg">
        <AvatarImage src={CHEF_PHOTO} alt="Head chef" />
        <AvatarFallback>HC</AvatarFallback>
      </Avatar>
    </div>
  )
}

/** 20. Thumbnail */
export function ThumbnailDemo() {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <Thumbnail size="sm" src={CROISSANT_PHOTO} alt="Butter croissant" />
      <Thumbnail src={CROISSANT_PHOTO} alt="Butter croissant" />
      <Thumbnail size="lg" src={CROISSANT_PHOTO} alt="Butter croissant" />
      <Thumbnail size="lg" alt="No photo for Kouign amann" />
    </div>
  )
}

/** 21. Image */
export function ImageDemo() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={PREP_PHOTO}
      alt="Croissants proofing on a sheet tray"
      className="aspect-3/1 w-full rounded-lg border border-border object-cover"
    />
  )
}

/** 22. Icon */
export function IconDemo() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-5">
        <span className="flex items-center gap-2 text-2xs text-faint">
          <SquarePen className="size-3.5 text-foreground" aria-hidden="true" />
          14px in a button
        </span>
        <span className="flex items-center gap-2 text-2xs text-faint">
          <Check className="size-[15px] text-foreground" aria-hidden="true" />
          15px check slot
        </span>
        <span className="flex items-center gap-2 text-2xs text-faint">
          <Clock className="size-[17px] text-foreground" aria-hidden="true" />
          17px menu row
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <SquarePen className="size-[17px] text-foreground" aria-hidden="true" />
        <SquarePen
          className="size-[17px] text-muted-foreground"
          aria-hidden="true"
        />
        <Check className="size-[17px] text-success" aria-hidden="true" />
        <TriangleAlert
          className="size-[17px] text-destructive"
          aria-hidden="true"
        />
        <TriangleAlert
          className="size-[17px] text-warning"
          aria-hidden="true"
        />
        <TrendingUp className="size-[17px] text-primary" aria-hidden="true" />
      </div>
    </div>
  )
}

/** 23. Text field */
export function TextFieldDemo() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <LabeledInput label="Recipe name" placeholder="Butter croissant" />
      <LabeledInput label="Supplier" defaultValue="Baldor" />
      <Field>
        <FieldLabel htmlFor="guide-station">Station</FieldLabel>
        <Input id="guide-station" defaultValue="Pastry" />
        <FieldDescription>
          Shown on the prep sheet the kitchen prints.
        </FieldDescription>
      </Field>
      <Field data-invalid="true">
        <FieldLabel htmlFor="guide-yield">Yield</FieldLabel>
        <Input id="guide-yield" aria-invalid defaultValue="0" />
        <FieldError>Yield has to be greater than zero.</FieldError>
      </Field>
      <LabeledInput label="Batch code" defaultValue="BC-2026-09" disabled />
    </div>
  )
}

/** 24. Text area */
export function TextAreaDemo() {
  return (
    <Field className="max-w-[420px]">
      <FieldLabel htmlFor="guide-method">Method</FieldLabel>
      <Textarea
        id="guide-method"
        defaultValue={
          "Laminate in three single folds, resting 30 minutes between them. Proof at 26 C until doubled, then egg wash and bake at 190 C for 18 minutes."
        }
      />
      <FieldDescription>
        The method prints with the recipe, so write it the way the kitchen reads
        it.
      </FieldDescription>
    </Field>
  )
}

/** 25. Number field */
export function NumberFieldDemo() {
  const [batches, setBatches] = React.useState<number | null>(2)
  const [days, setDays] = React.useState<number | null>(7)
  return (
    <div className="grid max-w-[420px] gap-4 md:grid-cols-2">
      <NumberField
        label="Batches"
        value={batches}
        onValueChange={(next) => setBatches(next)}
        min={1}
        max={12}
        step={1}
      />
      <NumberField
        label="Days of cover"
        value={days}
        onValueChange={(next) => setDays(next)}
        min={1}
        max={30}
        step={1}
      />
    </div>
  )
}

/** 26. Money field */
export function MoneyFieldDemo() {
  return (
    <div className="grid max-w-[420px] gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="guide-price">Case price</FieldLabel>
        <InputGroup>
          <InputAffix>$</InputAffix>
          <Input id="guide-price" className="pl-[26px]" defaultValue="74.00" />
        </InputGroup>
      </div>
      <div className="flex flex-col gap-2">
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
    </div>
  )
}
