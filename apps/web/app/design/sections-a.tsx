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
 * Each entry is one article section: the `id` is the heading anchor and the
 * contents-rail link, the `description` states the component's own rules, and
 * `Demo` renders the live pane body. The page supplies the heading, the pane
 * and its caption, so a demo draws its content and nothing around it.
 *
 * The demos live in `sections-a-demos.tsx`, which is the client module; this
 * file stays a server module so the page can read the array itself.
 */
export const SECTIONS_A: GuideSection[] = [
  {
    id: "page",
    title: "Page",
    description:
      "Every screen is the same frame: the way back and a 24px title, then a toolbar of search, filters, a spacer and the actions, 16px above the content it filters. Every control in that row is 32px, and the one primary action sits last on the right.",
    Demo: PageDemo,
  },
  {
    id: "section",
    title: "Section",
    description:
      "A section is a card: rounded-xl over one hairline on the card fill, 20px of padding and 16px between the blocks inside it. There is no elevation anywhere in this design, so the hairline is the only edge. The metric card beside it is the same shell around a 26px figure.",
    Demo: SectionDemo,
  },
  {
    id: "heading",
    title: "Heading",
    description:
      "Forkluck has no Heading component; a heading picks a step from the type scale. Four of the ten steps carry one: 24px for a page title, 17px for a dialog title or a section heading, 16px for a card heading, 14px for a list title. No step carries a line height of its own.",
    Demo: HeadingDemo,
  },
  {
    id: "text",
    title: "Text",
    description:
      "Forkluck has no Text component; tone is a colour token on the class. Body text is 13.5px ink, quieter lines step down through muted and faint rather than shrinking, and the semantic inks are one green, one red and one amber. Meta lines are 11.5px.",
    Demo: TextDemo,
  },
  {
    id: "paragraph",
    title: "Paragraph",
    description:
      "Forkluck has no Paragraph component either. Because no type step carries a line height, prose opts into its own: body copy runs at 13.5px over 1.65, and help text at 12.5px over 1.55 in muted ink.",
    Demo: ParagraphDemo,
  },
  {
    id: "link",
    title: "Link",
    description:
      "A link is the accent: brand blue that underlines on hover. Blue is otherwise reserved for data and selection, so running text is the one place it appears as a colour to read. The link button and the link badge wear the same ink on the shapes they belong to.",
    Demo: LinkDemo,
  },
  {
    id: "unordered-list",
    title: "Unordered list",
    description: (
      <>
        Forkluck has no List component. A list in content is{" "}
        <code>list-disc pl-5</code> with a 4px gap between items, at body size
        in muted ink.
      </>
    ),
    Demo: UnorderedListDemo,
  },
  {
    id: "ordered-list",
    title: "Ordered list",
    description: (
      <>
        The same idiom with <code>list-decimal</code>, and no component behind
        it either. The numbers are the browser&apos;s own.
      </>
    ),
    Demo: OrderedListDemo,
  },
  {
    id: "button",
    title: "Button",
    description:
      "Emphasis comes from the variant, never from the size: an ink fill for the one primary action, then outline, filled grey and ghost below it, with destructive outside the scale. Every button is rounded-lg and sits on the 24, 28, 32 and 36px rungs, icon buttons included, so a toolbar of mixed sizes shares one corner. Pending disables the button and leads with a 16px spinner while keeping the label.",
    Demo: ButtonDemo,
  },
  {
    id: "button-group",
    title: "Button group",
    description:
      "Forkluck has no ButtonGroup component; a row of actions is an 8px gap with the primary last. A dialog footer and a toolbar's right cluster are the same row, which is why the two read alike.",
    Demo: ButtonGroupDemo,
  },
  {
    id: "press-button",
    title: "Press button",
    description:
      "A toggle is the button that stays down. It wears the outline button shell at 32px on rounded-lg, so it lines up with the buttons beside it, and pressed fills with grey rather than ink or the accent: a held control is a state, not the one action of the view. Click it.",
    Demo: PressButtonDemo,
  },
  {
    id: "clickable",
    title: "Clickable",
    description:
      "A card takes a render prop, so the whole surface can be one link. There is no shadow and no focus ring here: the hairline firms to line-strong under the cursor and turns ink on focus. Hover it, then tab into it.",
    Demo: ClickableDemo,
  },
  {
    id: "badge",
    title: "Badge",
    description:
      "Badges label, they never act, so they carry no accent and no ink fill. One height, 20px, in two shapes: the rounded-full metric badge at 12.5px and the rounded-md row chip at 11.5px, both taking the same one red, one green and one amber.",
    Demo: BadgeDemo,
  },
  {
    id: "banner",
    title: "Banner",
    description:
      "The notice banner is a 48px amber strip on the warning fill over the warning border, with an outline action pinned right, and it sits between a screen's toolbar and its table. The save banner is the quieter rounded-xl strip above an editor that needs a decision. The third kind of feedback is the toast, an ink pill that says what happened once an action has landed.",
    Demo: BannerDemo,
  },
  {
    id: "chip",
    title: "Chip",
    description:
      "A chip is the 20px rung of the control ladder: the badge's row size on rounded-md, the small grey tag at 11.5px, and the unit chip that sits inside a measure field. They label an amount or a tag and stay out of the accent.",
    Demo: ChipDemo,
  },
  {
    id: "clickable-chip",
    title: "Clickable chip",
    description:
      "A chip presses or removes, never both, because a button cannot sit inside a button. The pressable one carries aria-pressed and fills with ink when it is chosen; the removable one keeps its hairline and ends in a 12px X with a name of its own. Click one.",
    Demo: ClickableChipDemo,
  },
  {
    id: "spinner",
    title: "Spinner",
    description:
      "One ring, spun, whose stroke tracks its diameter: 16px inside a control, 32px standing in for a card, 80px for a whole page. A press that waits on the server shows the wait on the control that was pressed, and content about to be replaced dims behind a single mark instead of disappearing.",
    Demo: SpinnerDemo,
  },
  {
    id: "tooltip",
    title: "Tooltip",
    description:
      "The tooltip is the only floating element in this design that is not white: an ink pill at 12.5px with an arrow, 6px off its trigger. It names an icon button that has no label of its own. Hover it.",
    Demo: TooltipDemo,
  },
  {
    id: "avatar",
    title: "Avatar",
    description:
      "An avatar is always rounded-full on the secondary grey, at 24, 32 or 36px, so it lines up with the buttons beside it in a toolbar or a row. Initials step down with the size and carry no colour of their own. A photo only swaps in once it has loaded, so the initials stay up until then.",
    Demo: AvatarDemo,
  },
  {
    id: "thumbnail",
    title: "Thumbnail",
    description:
      "The images Forkluck holds are invoice scans and attachments, and this is their tile: a square at 32, 48 or 64px, rounded-md over one hairline, cropped with object-cover so a column of them keeps one edge whatever shape the file is. Without a file it draws the same tile on the soft fill with a muted icon, named by the alt text.",
    Demo: ThumbnailDemo,
  },
  {
    id: "image",
    title: "Image",
    description:
      "Forkluck has no Image component. A picture in content is a plain img at rounded-lg over one hairline, cropped to the aspect ratio the layout gives it.",
    Demo: ImageDemo,
  },
  {
    id: "icon",
    title: "Icon",
    description:
      "Icons are lucide, and there is no wrapper around them. Three sizes do all the work: 14px inside a button, 15px in a menu's check slot, 17px in a menu row, where the icon plus its gap is a structural 27px lane. Tone is a text colour token, and blue stays with data and selection.",
    Demo: IconDemo,
  },
  {
    id: "text-field",
    title: "Text field",
    description:
      "Fields are 36px on rounded-md over an input hairline, squarer than the buttons beside them because a control you type into is not one you press. Hover firms the line to line-strong and focus turns it ink; there is no focus ring anywhere in this design. Help text sits under the field, and an invalid field reddens its border and its message. Click into one.",
    Demo: TextFieldDemo,
  },
  {
    id: "text-area",
    title: "Text area",
    description:
      "The text area is the field's edges and states grown to hold wrapped text, on the same rounded-md corner and the same hairline. It sizes to its content rather than scrolling inside a fixed height.",
    Demo: TextAreaDemo,
  },
  {
    id: "number-field",
    title: "Number field",
    description:
      "A quantity a cook steps up and down: batch size, yield, days of cover. The shell is the text field itself, 36px on rounded-md, with the 24px ghost icon button at each end, so a number and a name in one form draw the same edge at the same height. Click a stepper.",
    Demo: NumberFieldDemo,
  },
  {
    id: "money-field",
    title: "Money field",
    description:
      "Money is a field with an affix: the dollar sign sits on the input's own 12px padding, never takes a click, and the field behind it stays the whole hit area. The call site pads the text past it, and a rate hangs its unit off the other end the same way.",
    Demo: MoneyFieldDemo,
  },
]
