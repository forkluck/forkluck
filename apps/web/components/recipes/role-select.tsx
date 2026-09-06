"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export type ShareRole = "viewer" | "editor"

const ROLES: { value: ShareRole; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
]

/** The two-value role picker, on a recipe share and on a kitchen member row. */
export function RoleSelect({
  value,
  disabled = false,
  onChange,
}: {
  value: ShareRole
  disabled?: boolean
  onChange: (role: ShareRole) => void
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as ShareRole)}
    >
      <SelectTrigger size="sm" className="w-28">
        <SelectValue>
          {ROLES.find((role) => role.value === value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((role) => (
          <SelectItem key={role.value} value={role.value}>
            {role.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
