import type { GuideSection } from "./demos"
import {
  BoxDemo,
  CheckboxDemo,
  ChoiceListDemo,
  ColorFieldDemo,
  ColorPickerDemo,
  DateFieldDemo,
  DatePickerDemo,
  DividerDemo,
  DropZoneDemo,
  EmailFieldDemo,
  EmptyStateDemo,
  GridDemo,
  MenuDemo,
  ModalDemo,
  NumberDemo,
  PasswordFieldDemo,
  PopoverDemo,
  QueryContainerDemo,
  ScrollBoxDemo,
  SearchFieldDemo,
  SelectDemo,
  StackDemo,
  SwitchDemo,
  TableDemo,
  UrlFieldDemo,
} from "./sections-b-demos"

/**
 * Sections 27 to 51 of the visual guide, in the owner's order: the rest of the
 * fields, the choice controls, the table, the layout primitives, the overlays
 * and the numbers.
 *
 * Each entry is one article section: the `id` is the heading anchor and the
 * contents-rail link, the `description` states the component's own rules, and
 * `Demo` renders the live pane body from `sections-b-demos.tsx`. The page
 * supplies the heading, the pane and its caption, so a demo draws its content
 * and nothing around it.
 */

export const SECTIONS_B: GuideSection[] = [
  {
    id: "email-field",
    title: "Email field",
    description:
      "An email address is the standard field: 36px tall, rounded-md, one hairline that firms to grey on hover and turns ink on focus. The label above it is 13px medium, eight pixels clear of the box. Click into one.",
    Demo: EmailFieldDemo,
  },
  {
    id: "password-field",
    title: "Password field",
    description:
      'The same 36px box with type="password", so the browser handles masking and the design changes nothing. Help text sits under the field at 12.5px muted.',
    Demo: PasswordFieldDemo,
  },
  {
    id: "url-field",
    title: "URL field",
    description:
      "A prefix goes in an InputAffix, which owns the 12px inset and the vertical centering and is never a click target. The field pads past it, so the whole box stays the hit area.",
    Demo: UrlFieldDemo,
  },
  {
    id: "search-field",
    title: "Search field",
    description:
      "Search is the 32px variant of the same field, so a toolbar's search and its buttons share one height and one corner. The 15px magnifier is the only chrome: the browser's own clear button is hidden, because it empties the box without telling the filter.",
    Demo: SearchFieldDemo,
  },
  {
    id: "select",
    title: "Select",
    description:
      "The picker is 36px with a 13px chevron, and sm is the 32px toolbar size. Its list is the same popover surface as a menu: white, one hairline, rounded-lg, 6px under the trigger, with a 15px check slot every row reserves so picking one never shifts the list. Open it.",
    Demo: SelectDemo,
  },
  {
    id: "date-field",
    title: "Date field",
    description:
      "A date is typed as YYYY-MM-DD and the trailing quiet button opens one month of the app's own calendar, never the operating system's. The calendar reads today in the kitchen's timezone, which is UTC here. Open it.",
    Demo: DateFieldDemo,
  },
  {
    id: "date-picker",
    title: "Date picker",
    description:
      "One month grid: a filled ink circle on the selected day, a ring on today, and the whole cell as the hit area. The reporting period filter decorates the same grid with its range fills, and its presets sit beside it. Open it.",
    Demo: DatePickerDemo,
  },
  {
    id: "color-field",
    title: "Color field",
    description:
      "A colour as a labelled field: the hex is the value, and a 16px rounded-sm swatch sits on the field's own inset. The swatch lane is a real button that opens the picker in a popover, so the affix keeps its contract and the field still takes a hex typed straight in. Open it.",
    Demo: ColorFieldDemo,
  },
  {
    id: "color-picker",
    title: "Color picker",
    description:
      "The swatches are the semantic and chart colours from globals.css, each a 24px rounded-md button carrying its hex as its name. The selected one wears the ink border every selected control here wears, and the hex field is the standard 36px input.",
    Demo: ColorPickerDemo,
  },
  {
    id: "drop-zone",
    title: "Drop zone",
    description:
      "A dashed line-strong box on the soft fill, rounded-xl like every other surface, with the outline button as the pointer's affordance. The whole box is the hit area and answers Enter and Space, and the dashed line turns ink while files are over it.",
    Demo: DropZoneDemo,
  },
  {
    id: "checkbox",
    title: "Checkbox",
    description:
      "A 15px box on a grey edge, ink when it is on, because selection is ink here and blue stays with data. Partial selection shows a dash on the same ink fill, and an invalid box reddens with its label.",
    Demo: CheckboxDemo,
  },
  {
    id: "choice-list",
    title: "Choice list",
    description:
      "One choice out of a short visible list is a radio group: a 16px circle on the field hairline with an ink dot when it is checked. Several choices at once is a group of checkboxes instead. Both sit in a fieldset with a 13px legend.",
    Demo: ChoiceListDemo,
  },
  {
    id: "switch",
    title: "Switch",
    description:
      "A switch is a setting that takes effect at once, not a value to save, so it carries the brand fill when it is on. The track is 20px tall, or 16px at sm for an inline row, and the hit area runs well past what is drawn.",
    Demo: SwitchDemo,
  },
  {
    id: "table",
    title: "Table",
    description:
      "Rows are 48px over a light rule, the header 48px over the one border rule that separates it from the body, and there is no outer card: the two horizontal rules are the whole frame. Numbers are tabular and right aligned, a state is a row badge, and every row ends in the ghost actions button.",
    Demo: TableDemo,
  },
  {
    id: "divider",
    title: "Divider",
    description:
      "One hairline in the border token, horizontal or vertical. The field separator is the same rule with a word sitting on the background over it, for the or between two ways into a form.",
    Demo: DividerDemo,
  },
  {
    id: "box",
    title: "Box",
    description:
      "Forkluck has no generic Box component. A surface is a Card, rounded-xl over one hairline with 20px of padding, and a call site that needs less overrides the padding; a quiet panel inside one is bg-fill-soft or bg-secondary with no border at all.",
    Demo: BoxDemo,
  },
  {
    id: "stack",
    title: "Stack",
    description:
      "Forkluck has no Stack component and shows the Tailwind idiom instead: flex flex-col with gap-2 for rows that belong together and gap-4 for blocks that do not. An action row is flex gap-2 with the primary button last.",
    Demo: StackDemo,
  },
  {
    id: "grid",
    title: "Grid",
    description:
      "Forkluck has no Grid component either. A detail screen is grid gap-4 with md:grid-cols-[2fr_1fr], the wide column carrying the table and the narrow one the summary, stacking on a phone.",
    Demo: GridDemo,
  },
  {
    id: "scroll-box",
    title: "Scroll box",
    description:
      "A box that scrolls its own content instead of the page, for a long list inside a dialog or a popover. The call site sets the height; the bar is 6px of line-strong, rounded-full, and fades in while the box is hovered or scrolling.",
    Demo: ScrollBoxDemo,
  },
  {
    id: "query-container",
    title: "Query container",
    description:
      "Forkluck has no container component and uses Tailwind's @container directly: the toolbar stacks at narrow widths and turns into a row at @md, measuring the card it sits in rather than the viewport. Drag the window narrow to see it reflow.",
    Demo: QueryContainerDemo,
  },
  {
    id: "popover",
    title: "Popover",
    description:
      "The menu's chrome with free content inside it, for the things a list of rows cannot hold. Same white surface, same hairline, same rounded-lg, hanging 6px under its trigger, with 12px of padding instead of the menu's 6. Open it.",
    Demo: PopoverDemo,
  },
  {
    id: "menu",
    title: "Menu",
    description:
      "Rows are 36px, rounded-md, and a row that runs a command always carries a 17px icon: the icon plus its gap is a 27px lane, so two menus opened from neighbouring controls agree about where their labels begin. A row that picks a value is a check item and reserves the 15px check slot in the same lane. Open them.",
    Demo: MenuDemo,
  },
  {
    id: "modal",
    title: "Modal",
    description:
      "Dialogs come in five widths set by size, sm at 470px by default, on the card's rounded-xl over one hairline. The scrim is the only depth in this design, since there are no shadows, and the confirm shape puts two equal buttons side by side so neither answer reads as the safe one. Open them.",
    Demo: ModalDemo,
  },
  {
    id: "empty-state",
    title: "Empty state",
    description:
      "The empty card is rounded-xl over one hairline: a 17px heading, one line of prose at 46 characters wide, and up to two actions. An empty table keeps its rows instead and shows one 48px message row, so the table does not double in height while it waits.",
    Demo: EmptyStateDemo,
  },
  {
    id: "number",
    title: "Number",
    description:
      "Every figure the app prints is tabular, so a column of costs lines up on the decimal. The metric card is a 12.5px label over a 26px numeral with an optional delta pill, green when the move is the one the kitchen wanted and red when it is not; 42px is the hero numeral, and there is no pill at all when there is no baseline to compare against.",
    Demo: NumberDemo,
  },
]
