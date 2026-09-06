import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select"
import { recipeUnitOptions } from "@/lib/unit-registry"

const UNIT_OPTIONS = recipeUnitOptions()

/** The unit list under its family headings; the anchor is too narrow to host it. */
export function UnitOptions() {
  const headings = [...new Set(UNIT_OPTIONS.map((unit) => unit.heading))]
  return headings.map((heading) => (
    <SelectGroup key={heading}>
      <SelectLabel>{heading}</SelectLabel>
      {UNIT_OPTIONS.filter((unit) => unit.heading === heading).map((unit) => (
        <SelectItem key={unit.slug} value={unit.slug}>
          {unit.label}
        </SelectItem>
      ))}
    </SelectGroup>
  ))
}
