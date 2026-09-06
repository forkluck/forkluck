"use client"

import * as React from "react"
import { Trash2 } from "lucide-react"

import {
  inviteKitchenMember,
  listKitchenMembers,
  removeKitchenInvite,
  removeKitchenMember,
  updateKitchenMember,
  type KitchenMembersPayload,
} from "@/app/(app)/settings/actions"
import { RoleSelect, type ShareRole } from "@/components/recipes/role-select"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toast"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure } from "@/lib/save-failure"

const EMAIL_FIELD = "member-email"

/**
 * Who else can open the kitchen's recipe book. The share dialog is the same
 * modal one recipe at a time; this one hands over the whole book, so the list
 * is read here rather than passed in, and every write re-reads it.
 */
export function MembersDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const toast = useToast()
  const [rows, setRows] = React.useState<KitchenMembersPayload | null>(null)
  const [email, setEmail] = React.useState("")
  const [role, setRole] = React.useState<ShareRole>("viewer")
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(
    (cancelled?: () => boolean) =>
      listKitchenMembers()
        .then((payload) => {
          if (!cancelled?.()) setRows(payload)
        })
        .catch(() => {
          if (!cancelled?.()) setError("Couldn’t load your members.")
        }),
    []
  )

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    void load(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [open, load])

  // A row write is a command with no form behind it: it either moves the list
  // or leaves a line saying why it did not.
  async function apply(result: { ok: true } | { error: string }) {
    if ("error" in result) {
      setError(result.error)
      return
    }
    setError(null)
    await load()
  }
  // The row whose write is in flight: its control stays busy until the list
  // has been read back.
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const run = async (
    id: string,
    write: () => Promise<{ ok: true } | { error: string }>
  ) => {
    setBusyId(id)
    try {
      await apply(await write())
    } finally {
      setBusyId(null)
    }
  }

  const invite = useFormSave({
    snapshot: JSON.stringify([email, role]),
    // An invite is a command, so the same address can be sent again.
    saved: false,
    validate: (): FormErrors =>
      email.trim() ? {} : { [EMAIL_FIELD]: "Enter an email." },
    save: async () => {
      const address = email.trim()
      const result = await inviteKitchenMember({ email: address, role })
      if ("error" in result) return toSaveFailure(result)
      // An address with no account is invited to make one; an account joins.
      toast.add({
        title: result.invited
          ? `Invite sent to ${address}`
          : `${address} added`,
      })
      setEmail("")
      setError(null)
      await load()
      return null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  // An address still in the field is unsent work, so closing asks first.
  const dismiss = () => confirm(email.trim() !== "", () => onOpenChange(false))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent
        size="md"
        onKeyDown={dialogSaveShortcut(() => void invite.submit())}
      >
        <DialogHeader>
          <DialogTitle>Members</DialogTitle>
          <DialogDescription>
            Editors can add and change recipes. Viewers can only read. Nobody
            but you sees cost.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void invite.submit()
          }}
        >
          <Input
            id={EMAIL_FIELD}
            className="min-w-48 flex-1"
            type="email"
            value={email}
            placeholder="cook@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
          <RoleSelect value={role} onChange={setRole} />
          <Button type="submit" variant="outline" pending={invite.pending}>
            Invite
          </Button>
          {invite.errors[EMAIL_FIELD] || invite.failure ? (
            <p role="alert" className="w-full text-base text-destructive">
              {invite.errors[EMAIL_FIELD] ?? invite.failure?.message}
            </p>
          ) : null}
        </form>

        <div className="grid gap-2">
          {rows?.members.map((member) => (
            <div
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{member.name}</span>
                <span className="block truncate text-muted-foreground">
                  {member.email}
                </span>
              </span>
              <div className="flex items-center gap-2">
                <RoleSelect
                  value={member.role}
                  disabled={busyId === member.id}
                  onChange={(next) =>
                    void run(member.id, () =>
                      updateKitchenMember({
                        memberId: member.memberId,
                        role: next,
                      })
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${member.name}`}
                  pending={busyId === member.id}
                  onClick={() =>
                    void run(member.id, () =>
                      removeKitchenMember({ membershipId: member.id })
                    )
                  }
                >
                  {busyId === member.id ? null : <Trash2 />}
                </Button>
              </div>
            </div>
          ))}
          {rows?.invites.map((pending) => (
            <div
              key={pending.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="truncate">{pending.email}</span>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {pending.role === "editor" ? "Editor" : "Viewer"} · Invited
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Revoke ${pending.email}`}
                  pending={busyId === pending.id}
                  onClick={() =>
                    void run(pending.id, () =>
                      removeKitchenInvite({ inviteId: pending.id })
                    )
                  }
                >
                  {busyId === pending.id ? null : <Trash2 />}
                </Button>
              </div>
            </div>
          ))}
          {rows && rows.members.length === 0 && rows.invites.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="text-base text-destructive">
            {error}
          </p>
        ) : null}
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
