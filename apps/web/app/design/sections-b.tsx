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
 * An entry is a heading anchor, the component's name and the `Demo` that lays
 * the component out: every variant, size and state it has, in a `Matrix` or a
 * `Row`, on the bare page. The page supplies the heading and nothing else.
 */

export const SECTIONS_B: GuideSection[] = [
  { id: "email-field", title: "Email field", Demo: EmailFieldDemo },
  { id: "password-field", title: "Password field", Demo: PasswordFieldDemo },
  { id: "url-field", title: "URL field", Demo: UrlFieldDemo },
  { id: "search-field", title: "Search field", Demo: SearchFieldDemo },
  { id: "select", title: "Select", Demo: SelectDemo },
  { id: "date-field", title: "Date field", Demo: DateFieldDemo },
  { id: "date-picker", title: "Date picker", Demo: DatePickerDemo },
  { id: "color-field", title: "Color field", Demo: ColorFieldDemo },
  { id: "color-picker", title: "Color picker", Demo: ColorPickerDemo },
  { id: "drop-zone", title: "Drop zone", Demo: DropZoneDemo },
  { id: "checkbox", title: "Checkbox", Demo: CheckboxDemo },
  { id: "choice-list", title: "Choice list", Demo: ChoiceListDemo },
  { id: "switch", title: "Switch", Demo: SwitchDemo },
  { id: "table", title: "Table", Demo: TableDemo },
  { id: "divider", title: "Divider", Demo: DividerDemo },
  { id: "box", title: "Box", Demo: BoxDemo },
  { id: "stack", title: "Stack", Demo: StackDemo },
  { id: "grid", title: "Grid", Demo: GridDemo },
  { id: "scroll-box", title: "Scroll box", Demo: ScrollBoxDemo },
  { id: "query-container", title: "Query container", Demo: QueryContainerDemo },
  { id: "popover", title: "Popover", Demo: PopoverDemo },
  { id: "menu", title: "Menu", Demo: MenuDemo },
  { id: "modal", title: "Modal", Demo: ModalDemo },
  { id: "empty-state", title: "Empty state", Demo: EmptyStateDemo },
  { id: "number", title: "Number", Demo: NumberDemo },
]
