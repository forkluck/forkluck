import type { GuideSection } from "./demos"

import {
  AvatarDemo,
  BadgeDemo,
  BannerDemo,
  ButtonDemo,
  ButtonGroupDemo,
  ChipDemo,
  ClickableChipDemo,
  ClickableDemo,
  HeadingDemo,
  IconDemo,
  ImageDemo,
  LinkDemo,
  MoneyFieldDemo,
  NumberFieldDemo,
  OrderedListDemo,
  PageDemo,
  ParagraphDemo,
  PressButtonDemo,
  SectionDemo,
  SpinnerDemo,
  TextAreaDemo,
  TextDemo,
  TextFieldDemo,
  ThumbnailDemo,
  TooltipDemo,
  UnorderedListDemo,
} from "./sections-a-demos"

/**
 * Sections 1 to 26 of the visual guide, in the owner's order: the page frame,
 * type, the pressable things, the small marks, and the first four fields.
 *
 * An entry is a heading anchor, the component's name, and the `Demo` that lays
 * its whole range out on the page. There is no prose: the demo is the
 * documentation, the way the Radix Themes playground's is.
 *
 * The demos live in `sections-a-demos.tsx`, which is the client module; this
 * file stays a server module so the page can read the array itself.
 */
export const SECTIONS_A: GuideSection[] = [
  { id: "page", title: "Page", Demo: PageDemo },
  { id: "section", title: "Section", Demo: SectionDemo },
  { id: "heading", title: "Heading", Demo: HeadingDemo },
  { id: "text", title: "Text", Demo: TextDemo },
  { id: "paragraph", title: "Paragraph", Demo: ParagraphDemo },
  { id: "link", title: "Link", Demo: LinkDemo },
  { id: "unordered-list", title: "Unordered list", Demo: UnorderedListDemo },
  { id: "ordered-list", title: "Ordered list", Demo: OrderedListDemo },
  { id: "button", title: "Button", Demo: ButtonDemo },
  { id: "button-group", title: "Button group", Demo: ButtonGroupDemo },
  { id: "press-button", title: "Press button", Demo: PressButtonDemo },
  { id: "clickable", title: "Clickable", Demo: ClickableDemo },
  { id: "badge", title: "Badge", Demo: BadgeDemo },
  { id: "banner", title: "Banner", Demo: BannerDemo },
  { id: "chip", title: "Chip", Demo: ChipDemo },
  { id: "clickable-chip", title: "Clickable chip", Demo: ClickableChipDemo },
  { id: "spinner", title: "Spinner", Demo: SpinnerDemo },
  { id: "tooltip", title: "Tooltip", Demo: TooltipDemo },
  { id: "avatar", title: "Avatar", Demo: AvatarDemo },
  { id: "thumbnail", title: "Thumbnail", Demo: ThumbnailDemo },
  { id: "image", title: "Image", Demo: ImageDemo },
  { id: "icon", title: "Icon", Demo: IconDemo },
  { id: "text-field", title: "Text field", Demo: TextFieldDemo },
  { id: "text-area", title: "Text area", Demo: TextAreaDemo },
  { id: "number-field", title: "Number field", Demo: NumberFieldDemo },
  { id: "money-field", title: "Money field", Demo: MoneyFieldDemo },
]
